# -*- coding: utf-8 -*-
import logging
from datetime import datetime, time

import pytz
from psycopg2 import IntegrityError

from odoo import _, api, fields, models
from odoo.exceptions import UserError
from odoo.tools import float_compare, float_is_zero, float_round
from odoo.tools.misc import format_datetime, formatLang

_logger = logging.getLogger(__name__)


def pqs_m2o_id(value):
    """Normalise a many2one value coming from the POS (dict, [id, name], id)."""
    if not value:
        return 0
    if isinstance(value, dict):
        return int(value.get('id') or 0)
    if isinstance(value, (list, tuple)):
        return int(value[0]) if value else 0
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


class SaleOrder(models.Model):
    _inherit = 'sale.order'

    pqs_pos_config_id = fields.Many2one(
        'pos.config', string='Created from POS', readonly=True, copy=False,
        index=True)
    pqs_pos_shop_name = fields.Char(
        string='POS Shop', readonly=True, copy=False)
    pqs_pos_session_id = fields.Many2one(
        'pos.session', string='POS Session', readonly=True, copy=False)
    pqs_pos_uid = fields.Char(
        string='POS Cart Reference', readonly=True, copy=False, index=True,
        help='Technical reference of the POS cart, used to avoid creating the '
             'same quotation twice.')
    pqs_expiry_datetime = fields.Datetime(
        string='Quotation Valid Until', readonly=True, copy=False,
        help='Expiry stamped when the quotation was created from the POS.')
    pqs_is_expired = fields.Boolean(
        string='Quotation Expired', compute='_compute_pqs_is_expired')

    _pqs_pos_uid_uniq = models.Constraint(
        'unique(pqs_pos_uid)',
        'A quotation was already created for this POS cart.',
    )

    @api.depends('pqs_expiry_datetime', 'state')
    def _compute_pqs_is_expired(self):
        now = fields.Datetime.now()
        for order in self:
            order.pqs_is_expired = bool(
                order.pqs_expiry_datetime
                and order.state in ('draft', 'sent')
                and now > order.pqs_expiry_datetime
            )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _pqs_tz(self):
        return (self.env.user.tz or self.env.context.get('tz')
                or self.env.company.partner_id.tz or 'UTC')

    def _pqs_format_dt(self, value):
        if not value:
            return ''
        return format_datetime(self.env, value, tz=self._pqs_tz())

    def _pqs_local_date(self, value):
        """UTC naive datetime -> date in the user's timezone."""
        tz = pytz.timezone(self._pqs_tz())
        return pytz.utc.localize(value).astimezone(tz).date()

    def _pqs_end_of_day_utc(self, value):
        """Date (user timezone) -> naive UTC datetime at 23:59:59 that day."""
        tz = pytz.timezone(self._pqs_tz())
        local = tz.localize(datetime.combine(value, time(23, 59, 59)))
        return local.astimezone(pytz.utc).replace(tzinfo=None)

    def write(self, vals):
        # The Sales "Expiration" date is the source of truth: extending or
        # shortening it moves the POS expiry. If the date is unchanged, the
        # precise (hour-based) POS expiry is kept.
        if 'validity_date' in vals and not self.env.context.get('pqs_skip_expiry_sync'):
            new_date = fields.Date.to_date(vals.get('validity_date'))
            for order in self:
                if not order.pqs_expiry_datetime and not order.pqs_pos_config_id:
                    continue  # not a POS quotation: validity_date is read directly
                if not new_date:
                    expiry = False
                elif order.pqs_expiry_datetime and order._pqs_local_date(order.pqs_expiry_datetime) == new_date:
                    continue
                else:
                    expiry = order._pqs_end_of_day_utc(new_date)
                super(SaleOrder, order).write({'pqs_expiry_datetime': expiry})
        return super().write(vals)

    def _pqs_is_quotation(self):
        self.ensure_one()
        return self.state in ('draft', 'sent')

    def _pqs_effective_expiry(self, config):
        """Expiry used by the governance, in priority order:
        1. the POS expiry (stamped at creation, follows the Sales Expiration);
        2. the Sales Expiration date (end of that day);
        3. the settling POS validity period counted from the quotation date.
        """
        self.ensure_one()
        if self.pqs_expiry_datetime:
            return self.pqs_expiry_datetime
        if self.validity_date:
            return self._pqs_end_of_day_utc(self.validity_date)
        if config and config._pqs_validity_active() and self.date_order:
            return self.date_order + config._pqs_validity_delta()
        return False

    def _pqs_settlement_prices(self, config):
        """Current unit price of every settleable line, computed server-side
        with the quotation's own pricelist and today's product prices, in the
        POS currency. Keys are strings (JSON)."""
        self.ensure_one()
        currency = config.currency_id if config else self.currency_id
        prices = {}
        for line in self._pqs_settleable_lines():
            qty = max(line._pqs_remaining_qty(), 0.0) or line.product_uom_qty or 1.0
            prices[str(line.id)] = line._pqs_current_price_unit(qty, currency)
        return prices

    def _pqs_expiry_status(self, config, now=None):
        """Return (expired, expiry) as evaluated for the settling POS."""
        self.ensure_one()
        if not config or not config._pqs_validity_active() or not self._pqs_is_quotation():
            return False, self.pqs_expiry_datetime or False
        expiry = self._pqs_effective_expiry(config)
        now = now or fields.Datetime.now()
        return bool(expiry and now > expiry), expiry

    def _pqs_settleable_lines(self):
        self.ensure_one()
        return self.order_line.filtered(
            lambda l: not l.display_type and not l.is_downpayment and l.product_id)

    def _pqs_block_reason(self):
        """Hard blocks that apply regardless of the validity governance."""
        self.ensure_one()
        if self.state == 'cancel':
            return _('Quotation %s is cancelled and cannot be settled.', self.name)
        lines = self._pqs_settleable_lines()
        if lines and not any(l._pqs_has_remaining_qty() for l in lines):
            return _('Quotation %s has already been fully settled.', self.name)
        return ''

    def _pqs_mode_label(self, config):
        selection = dict(config._fields['pqs_expiry_mode']._description_selection(self.env))
        return selection.get(config.pqs_expiry_mode, '')

    # ------------------------------------------------------------------
    # Settlement check (called from the POS Quotation/Order flow)
    # ------------------------------------------------------------------
    def pqs_check_pos_settlement(self, config_id):
        """Server verdict used by the POS before settling a sale order."""
        order = self.sudo().exists()
        config = self.env['pos.config'].sudo().browse(pqs_m2o_id(config_id)).exists()
        if len(order) != 1:
            return {'blocked': True, 'expired': False,
                    'message': _('The selected quotation could not be found.')}
        order = order[0]
        result = {
            'order_id': order.id,
            'name': order.name,
            'state': order.state,
            'blocked': False,
            'expired': False,
            'mode': config.pqs_expiry_mode if config else False,
            'mode_label': order._pqs_mode_label(config) if config else '',
            'expiry': False,
            'expiry_display': '',
            'message': '',
        }
        reason = order._pqs_block_reason()
        if reason:
            result.update(blocked=True, message=reason)
            return result
        expired, expiry = order._pqs_expiry_status(config)
        governed = bool(config and config._pqs_validity_active() and order._pqs_is_quotation())
        result.update(
            expired=expired,
            governed=governed,
            expiry=fields.Datetime.to_string(expiry) if (governed and expiry) else False,
            expiry_display=order._pqs_format_dt(expiry) if governed else '',
            # Server prices are sent whenever Block mode governs the
            # quotation, so the POS can re-price and also enforce the rule
            # offline if the quotation expires before the payment.
            prices=order._pqs_settlement_prices(config)
            if governed and config.pqs_expiry_mode == 'block' else {},
        )
        if expired:
            if config.pqs_expiry_mode == 'block':
                result['message'] = _(
                    'Quotation %(name)s expired on %(expiry)s. It can only be '
                    'settled at the current prices.',
                    name=order.name, expiry=result['expiry_display'])
            else:
                result['message'] = _(
                    'Quotation %(name)s expired on %(expiry)s. Settling it '
                    'now keeps the original quotation prices.',
                    name=order.name, expiry=result['expiry_display'])
        return result

    # ------------------------------------------------------------------
    # Quotation creation from the POS
    # ------------------------------------------------------------------
    @api.model
    def pqs_create_quotation_from_pos(self, payload):
        payload = payload or {}
        config = self.env['pos.config'].browse(pqs_m2o_id(payload.get('config_id'))).exists()
        if not config:
            raise UserError(_('The Point of Sale configuration was not found.'))
        if not config.pqs_quotation_enabled:
            raise UserError(_(
                'Creating quotations is not enabled for the Point of Sale "%s".',
                config.name))
        session = self.env['pos.session'].browse(pqs_m2o_id(payload.get('session_id'))).exists()
        if not session or session.config_id != config or session.state != 'opened':
            raise UserError(_(
                'Quotations can only be created from an open session of this '
                'Point of Sale.'))

        uid = (payload.get('uid') or '').strip()
        if uid:
            existing = self.sudo().search([('pqs_pos_uid', '=', uid)], limit=1)
            if existing:
                # Idempotent: a retried request returns the same quotation.
                return existing._pqs_quotation_receipt_data()

        partner = self.env['res.partner'].browse(pqs_m2o_id(payload.get('partner_id'))).exists()
        if not partner:
            raise UserError(_('Please select a customer before creating a quotation.'))

        pricelist = self.env['product.pricelist'].browse(
            pqs_m2o_id(payload.get('pricelist_id'))).exists() or config.pricelist_id
        allowed_pricelists = config.available_pricelist_ids | config.pricelist_id
        if pricelist and pricelist not in allowed_pricelists:
            raise UserError(_(
                'The pricelist "%s" is not available in this Point of Sale.',
                pricelist.display_name))
        if pricelist and config.currency_id and pricelist.currency_id != config.currency_id:
            raise UserError(_(
                'The pricelist currency must match the Point of Sale currency.'))
        fiscal_position = self.env['account.fiscal.position'].browse(
            pqs_m2o_id(payload.get('fiscal_position_id'))).exists()
        if fiscal_position:
            allowed_positions = (
                config.fiscal_position_ids
                | config.default_fiscal_position_id
                | partner.with_company(config.company_id).property_account_position_id
            )
            if fiscal_position not in allowed_positions:
                raise UserError(_(
                    'The fiscal position "%s" is not available in this Point of Sale.',
                    fiscal_position.display_name))

        line_commands = self._pqs_prepare_quotation_lines(payload.get('lines') or [])
        salesperson, fallback_used = self._pqs_resolve_salesperson(config, payload)
        tag = self._pqs_get_or_create_shop_tag(config)

        vals = {
            'partner_id': partner.id,
            'company_id': config.company_id.id,
            'user_id': salesperson.id,
            'tag_ids': [(4, tag.id)],
            'origin': '%s / %s' % (config.name, session.name),
            'order_line': line_commands,
            'pqs_pos_config_id': config.id,
            'pqs_pos_shop_name': config.name,
            'pqs_pos_session_id': session.id,
            'pqs_pos_uid': uid or False,
        }
        if pricelist:
            vals['pricelist_id'] = pricelist.id
        if fiscal_position:
            vals['fiscal_position_id'] = fiscal_position.id
        if config.crm_team_id:
            vals['team_id'] = config.crm_team_id.id
        if config._pqs_validity_active():
            expiry = fields.Datetime.now() + config._pqs_validity_delta()
            vals['pqs_expiry_datetime'] = expiry
            vals['validity_date'] = self._pqs_local_date(expiry)

        # POS users do not necessarily hold Sales rights: every input was
        # validated above, the record is created with elevated rights in the
        # POS company and create_uid stays the real POS user.
        order = self.sudo().with_company(config.company_id).create(vals)
        if config.crm_team_id and order.team_id != config.crm_team_id:
            order.team_id = config.crm_team_id
        order.message_post(body=_(
            'Quotation created from the Point of Sale %(shop)s (session '
            '%(session)s) without payment.', shop=config.name, session=session.name))
        result = order._pqs_quotation_receipt_data()
        result['salesperson_fallback'] = fallback_used
        return result

    @api.model
    def _pqs_prepare_quotation_lines(self, lines):
        Product = self.env['product.product']
        commands = []
        for line in lines:
            product = Product.browse(pqs_m2o_id(line.get('product_id'))).exists()
            if not product:
                raise UserError(_('A product in the cart could not be found.'))
            qty = float(line.get('qty') or 0.0)
            if float_compare(qty, 0.0, precision_rounding=product.uom_id.rounding or 0.01) <= 0:
                raise UserError(_(
                    'Quotations cannot contain zero or negative quantities '
                    '(product "%s"). Remove refund or zero-quantity lines first.',
                    product.display_name))
            price_unit = float(line.get('price_unit') or 0.0)
            discount = float(line.get('discount') or 0.0)
            if price_unit < 0.0:
                raise UserError(_(
                    'Quotations cannot contain negative prices (product "%s"). '
                    'Remove reward or discount lines first.', product.display_name))
            if discount < 0.0 or discount > 100.0:
                raise UserError(_(
                    'The discount of "%s" must be between 0 and 100%%.',
                    product.display_name))
            vals = {
                'product_id': product.id,
                'product_uom_qty': qty,
                'product_uom_id': product.uom_id.id,
                'price_unit': price_unit,
                'discount': discount,
            }
            note = (line.get('customer_note') or '').strip()
            if note:
                vals['name'] = '%s\n%s' % (
                    product.get_product_multiline_description_sale(), note)
            commands.append((0, 0, vals))
        if not commands:
            raise UserError(_('The cart is empty. Add products before creating a quotation.'))
        return commands

    @api.model
    def _pqs_is_valid_salesperson(self, user, config):
        return bool(
            user and user.active and not user.share
            and config.company_id in user.company_ids
        )

    @api.model
    def _pqs_resolve_salesperson(self, config, payload):
        """Return (user, fallback_used).

        With pos_hr the cashier is an employee: use its linked user. Without
        pos_hr the cashier is the logged-in user itself.
        """
        cashier_name = ''
        employee_id = pqs_m2o_id(payload.get('employee_id'))
        if employee_id and 'hr.employee' in self.env:
            employee = self.env['hr.employee'].sudo().browse(employee_id).exists()
            if not employee:
                raise UserError(_('The active cashier could not be found.'))
            cashier_name = employee.name
            user = employee.user_id
        else:
            user = self.env.user
            cashier_name = user.name
        if self._pqs_is_valid_salesperson(user, config):
            return user, False
        if config.pqs_salesperson_fallback == 'block':
            raise UserError(_(
                'The cashier "%s" is not linked to an active internal user, so '
                'no salesperson can be assigned. Link the employee to a user or '
                'change the fallback in the Point of Sale settings.', cashier_name))
        fallback = self.env.user
        if not self._pqs_is_valid_salesperson(fallback, config):
            raise UserError(_(
                'No valid salesperson could be assigned to the quotation.'))
        return fallback, True

    @api.model
    def _pqs_get_or_create_shop_tag(self, config):
        Tag = self.env['crm.tag'].sudo()
        name = (config.name or '').strip()
        tag = Tag.search([('name', '=ilike', name)], limit=1)
        if tag:
            return tag
        try:
            with self.env.cr.savepoint():
                return Tag.create({'name': name})
        except IntegrityError:
            # Created concurrently by another session (unique tag name).
            tag = Tag.search([('name', '=ilike', name)], limit=1)
            if not tag:
                raise
            return tag

    # ------------------------------------------------------------------
    # Receipt / PDF output
    # ------------------------------------------------------------------
    def _pqs_pdf_url(self):
        self.ensure_one()
        token = self.sudo()._portal_ensure_token()
        return '/pos_quotation_creation_settle/quotation/%s/pdf?access_token=%s' % (
            self.id, token)

    def _pqs_pdf_filename(self):
        self.ensure_one()
        return '%s.pdf' % self.sudo()._get_report_base_filename()

    def _pqs_render_quotation_pdf(self):
        self.ensure_one()
        content, _report_type = self.env['ir.actions.report'].sudo()._render_qweb_pdf(
            'sale.action_report_saleorder', [self.id])
        return content, self._pqs_pdf_filename()

    def _pqs_quotation_receipt_data(self):
        """Data for the POS quotation receipt. Intentionally no payment lines:
        a quotation records no payment."""
        self.ensure_one()
        order = self.sudo()
        lines = []
        for line in order.order_line.filtered(lambda l: not l.display_type):
            lines.append({
                'product_name': line.product_id.display_name or line.name,
                'note': '\n'.join(line.name.split('\n')[1:]) if line.name else '',
                'qty': line.product_uom_qty,
                'uom': line.product_uom_id.name,
                'price_unit': line.price_unit,
                'discount': line.discount,
                'price_subtotal': line.price_subtotal,
                'price_total': line.price_total,
            })
        return {
            'id': order.id,
            'name': order.name,
            'is_quotation': True,
            'state': order.state,
            'company_name': order.company_id.name,
            'company_vat': order.company_id.vat or '',
            'shop_name': order.pqs_pos_shop_name or '',
            'session_name': order.pqs_pos_session_id.name or '',
            'partner_name': order.partner_id.display_name,
            'partner_phone': order.partner_id.phone or order.partner_id.mobile or '',
            'date_order': order._pqs_format_dt(order.date_order),
            'expiry': fields.Datetime.to_string(order.pqs_expiry_datetime)
            if order.pqs_expiry_datetime else False,
            'expiry_display': order._pqs_format_dt(order.pqs_expiry_datetime),
            'salesperson': order.user_id.name or '',
            'team': order.team_id.name or '',
            'tags': ', '.join(order.tag_ids.mapped('name')),
            'currency_id': order.currency_id.id,
            'amount_untaxed': order.amount_untaxed,
            'amount_tax': order.amount_tax,
            'amount_total': order.amount_total,
            'lines': lines,
            'payment_lines': [],
            'pdf_url': order._pqs_pdf_url(),
            'pdf_filename': order._pqs_pdf_filename(),
            'salesperson_fallback': False,
        }


class SaleOrderLine(models.Model):
    _inherit = 'sale.order.line'

    def _pqs_remaining_qty(self):
        """Quantity still available for a POS settlement (mirrors pos_sale)."""
        self.ensure_one()
        if self.product_id.type == 'service':
            return max(self.product_uom_qty, self.qty_delivered) - self.qty_invoiced
        return self.product_uom_qty - max(self.qty_delivered, self.qty_invoiced)

    def _pqs_current_price_unit(self, qty, currency=None):
        """Today's unit price for this quotation line: the quotation's own
        pricelist applied to the current product prices, converted to
        ``currency`` (the POS currency)."""
        self.ensure_one()
        order = self.order_id
        today = fields.Date.context_today(self)
        product = self.product_id.with_company(order.company_id)
        qty = qty or 1.0
        if order.pricelist_id:
            price = order.pricelist_id._get_product_price(
                product, qty, uom=self.product_uom_id, date=today)
            price_currency = order.pricelist_id.currency_id
        else:
            price = product.uom_id._compute_price(product.lst_price, self.product_uom_id)
            price_currency = product.currency_id
        if currency and price_currency and price_currency != currency:
            price = price_currency._convert(price, currency, order.company_id, today)
        digits = self.env['decimal.precision'].precision_get('Product Price')
        return float_round(price, precision_digits=digits)

    def _pqs_format_price(self, amount, currency):
        return formatLang(self.env, amount, currency_obj=currency)

    def _pqs_has_remaining_qty(self):
        self.ensure_one()
        rounding = self.product_uom_id.rounding or 0.01
        return not float_is_zero(max(self._pqs_remaining_qty(), 0.0),
                                 precision_rounding=rounding)
