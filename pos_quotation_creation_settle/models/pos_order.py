# -*- coding: utf-8 -*-
from collections import defaultdict

from odoo import _, api, fields, models
from odoo.exceptions import UserError
from odoo.tools import float_compare

from .sale_order import pqs_m2o_id


class PosOrderLine(models.Model):
    _inherit = 'pos.order.line'

    pqs_repriced = fields.Boolean(
        string='Re-priced at Settlement', readonly=True, copy=False,
        help='The line comes from an expired quotation and was re-priced at '
             'the current POS prices when it was settled.')

    @api.model
    def _load_pos_data_fields(self, config):
        params = super()._load_pos_data_fields(config)
        params += ['pqs_repriced']
        return params


class PosOrder(models.Model):
    _inherit = 'pos.order'

    # ------------------------------------------------------------------
    # Shared validation
    # ------------------------------------------------------------------
    @api.model
    def _pqs_settlement_violations(self, config, lines, check_stock=False):
        """Return the list of reasons why these POS lines cannot be settled.

        ``lines`` are dicts with product_id, qty, price_unit, discount,
        sale_order_origin_id and sale_order_line_id (ids or POS objects).

        Block mode on an expired quotation requires every quotation line to
        carry exactly the current price computed by the server (quotation
        pricelist, today's product prices) and no discount.
        """
        messages = []
        if not config:
            return messages
        SaleOrder = self.env['sale.order'].sudo()
        SaleLine = self.env['sale.order.line'].sudo()
        down_payment_product = config.down_payment_product_id
        currency = config.currency_id
        now = fields.Datetime.now()
        expired_orders = {}
        stock_needed = defaultdict(float)

        def add(msg):
            if msg and msg not in messages:
                messages.append(msg)

        for line in lines:
            qty = float(line.get('qty') or 0.0)
            if qty <= 0:
                continue  # refunds and zero lines are outside this governance
            sol = SaleLine.browse(pqs_m2o_id(line.get('sale_order_line_id'))).exists()
            order = sol.order_id or SaleOrder.browse(
                pqs_m2o_id(line.get('sale_order_origin_id'))).exists()
            if not order:
                continue
            if order.id not in expired_orders:
                expired, _expiry = order._pqs_expiry_status(config, now)
                expired_orders[order.id] = expired
                if order.state == 'cancel':
                    add(_('Quotation %s is cancelled and cannot be settled.', order.name))
            expired = expired_orders[order.id]

            if sol and sol.is_downpayment:
                continue  # deduction of an earlier down payment, not a settlement
            if sol and not sol._pqs_has_remaining_qty():
                add(_('The line "%(product)s" of %(name)s has already been fully settled.',
                      product=sol.product_id.display_name, name=order.name))
                continue
            if sol and sol.product_id.is_storable:
                stock_needed[sol.product_id] += sol.product_uom_id._compute_quantity(
                    qty, sol.product_id.uom_id, raise_if_failure=False)

            if not (expired and config.pqs_expiry_mode == 'block'):
                continue
            product_id = pqs_m2o_id(line.get('product_id'))
            if not sol:
                # A new down payment (positive amount) is based on the original
                # quotation amount; a negative line deducts an earlier one.
                if (down_payment_product and product_id == down_payment_product.id
                        and float(line.get('price_unit') or 0.0) > 0):
                    add(_('Quotation %s has expired: a down payment based on its '
                          'original amount is not allowed.', order.name))
                continue
            required = sol._pqs_current_price_unit(qty, currency)
            price = float(line.get('price_unit') or 0.0)
            discount = float(line.get('discount') or 0.0)
            if (currency.compare_amounts(price, required) != 0
                    or float_compare(discount, 0.0, precision_digits=2) != 0):
                add(_('Quotation %(name)s has expired: "%(product)s" must be '
                      'settled at the current price %(price)s without discount.',
                      name=order.name, product=sol.product_id.display_name,
                      price=sol._pqs_format_price(required, currency)))

        if check_stock and stock_needed:
            location = config.picking_type_id.default_location_src_id
            for product, needed in stock_needed.items():
                available = product.with_context(location=location.id).qty_available \
                    if location else product.qty_available
                if float_compare(needed, available, precision_rounding=product.uom_id.rounding) > 0:
                    add(_('Not enough stock for "%(product)s": %(needed)s needed, '
                          '%(available)s available.',
                          product=product.display_name,
                          needed=round(needed, 3), available=round(available, 3)))
        return messages

    @api.model
    def pqs_validate_settlement(self, config_id, pricelist_id, lines):
        """RPC used by the POS payment screen before validating an order.
        ``pricelist_id`` is kept for API compatibility: current prices come
        from the quotation's own pricelist."""
        config = self.env['pos.config'].browse(pqs_m2o_id(config_id)).exists()
        messages = self._pqs_settlement_violations(
            config, lines or [], check_stock=bool(config.pqs_check_stock_before_settle))
        return {'ok': not messages, 'messages': messages}

    # ------------------------------------------------------------------
    # Synchronisation hook (authoritative enforcement)
    # ------------------------------------------------------------------
    @api.model
    def _pqs_lines_from_ui(self, data):
        lines = []
        for command in data.get('lines') or []:
            if isinstance(command, (list, tuple)) and len(command) == 3 and isinstance(command[2], dict):
                lines.append(command[2])
        return lines

    @api.model
    def _process_order(self, order, existing_order):
        draft = order.get('state') == 'draft'
        expired = {}
        config = self.env['pos.config']
        if not draft:
            session = self.env['pos.session'].browse(
                pqs_m2o_id(order.get('session_id'))).exists()
            config = session.config_id
            ui_lines = self._pqs_lines_from_ui(order)
            messages = self._pqs_settlement_violations(config, ui_lines)
            if messages:
                raise UserError('\n'.join(messages))
            # Evaluated now: pos_sale confirms the quotation while the order
            # is processed, after which it no longer counts as a quotation.
            expired = self._pqs_expired_orders(config, ui_lines)
        order_id = super()._process_order(order, existing_order)
        if expired:
            pos_order = self.browse(order_id)
            if config.pqs_expiry_mode == 'block':
                pos_order._pqs_apply_settled_prices(
                    self.env['sale.order'].sudo().browse(list(expired)))
            pos_order._pqs_log_expired_settlements(config, expired)
        return order_id

    @api.model
    def _pqs_expired_orders(self, config, ui_lines):
        """{sale.order id: expiry} of the expired quotations settled here."""
        result = {}
        if not config:
            return result
        SaleOrder = self.env['sale.order'].sudo()
        for line in ui_lines:
            order = SaleOrder.browse(pqs_m2o_id(line.get('sale_order_origin_id'))).exists()
            if order and order.id not in result:
                is_expired, expiry = order._pqs_expiry_status(config)
                if is_expired:
                    result[order.id] = expiry
        return result

    def _pqs_apply_settled_prices(self, sale_orders):
        """Expired Block-mode settlement: write the collected prices back to
        the quotation lines so the quotation total matches the payment."""
        if not sale_orders:
            return
        for pos_order in self.sudo():
            changes = defaultdict(list)
            for line in pos_order.lines.filtered(
                    lambda l: l.sale_order_line_id and not l.sale_order_line_id.is_downpayment
                    and l.sale_order_line_id.order_id in sale_orders):
                sol = line.sale_order_line_id
                line.pqs_repriced = True
                currency = sol.order_id.currency_id
                if (currency.compare_amounts(sol.price_unit, line.price_unit) == 0
                        and float_compare(sol.discount, line.discount, precision_digits=2) == 0):
                    continue
                changes[sol.order_id].append(_(
                    '%(product)s: %(old)s → %(new)s',
                    product=sol.product_id.display_name,
                    old=sol._pqs_format_price(sol.price_unit * (1 - sol.discount / 100.0), currency),
                    new=sol._pqs_format_price(line.price_unit * (1 - line.discount / 100.0), currency)))
                sol.write({'price_unit': line.price_unit, 'discount': line.discount})
            for sale_order, details in changes.items():
                sale_order.message_post(body=_(
                    'Quotation lines re-priced at the current prices by POS order '
                    '%(order)s: %(details)s',
                    order=pos_order.name, details='; '.join(details)))

    def _pqs_log_expired_settlements(self, config, expired):
        SaleOrder = self.env['sale.order'].sudo()
        for pos_order in self.sudo():
            for sale_order in SaleOrder.browse(list(expired)):
                lines = pos_order.lines.filtered(lambda l: l.sale_order_origin_id == sale_order)
                if not lines:
                    continue
                repriced = any(lines.mapped('pqs_repriced'))
                sale_order.message_post(body=_(
                    'Settled by POS order %(order)s after the quotation expired on '
                    '%(expiry)s (governance: %(mode)s, re-priced: %(repriced)s).',
                    order=pos_order.name,
                    expiry=sale_order._pqs_format_dt(expired[sale_order.id]),
                    mode=sale_order._pqs_mode_label(config),
                    repriced=_('Yes') if repriced else _('No')))
