# -*- coding: utf-8 -*-
from datetime import timedelta

from odoo import fields
from odoo.exceptions import UserError, ValidationError
from odoo.tests import tagged

from odoo.addons.point_of_sale.tests.common import TestPoSCommon


@tagged('post_install', '-at_install')
class TestPosQuotationCreationSettle(TestPoSCommon):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.pqs_team = cls.env['crm.team'].create({'name': 'POS Quotation Team'})
        cls.pqs_partner = cls.env['res.partner'].create({'name': 'Quotation Customer'})
        cls.pqs_product = cls.create_product('Quoted Product', cls.categ_basic, 100.0)
        cls.pqs_down_payment = cls.env['product.product'].create({
            'name': 'POS Down Payment',
            'type': 'service',
            'available_in_pos': True,
            'taxes_id': [(5, 0, 0)],
        })

    def setUp(self):
        super().setUp()
        self.config = self.basic_config
        self.config.write({
            'pqs_quotation_enabled': True,
            'crm_team_id': self.pqs_team.id,
            'down_payment_product_id': self.pqs_down_payment.id,
        })
        self.session = self.open_new_session()

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------
    def _payload(self, price=80.0, qty=2.0, **overrides):
        payload = {
            'config_id': self.config.id,
            'session_id': self.session.id,
            'uid': overrides.pop('uid', False),
            'partner_id': self.pqs_partner.id,
            'pricelist_id': self.config.pricelist_id.id,
            'fiscal_position_id': False,
            'employee_id': False,
            'lines': [{
                'product_id': self.pqs_product.id,
                'qty': qty,
                'price_unit': price,
                'discount': 0.0,
                'customer_note': '',
            }],
        }
        payload.update(overrides)
        return payload

    def _create_quotation(self, **kwargs):
        result = self.env['sale.order'].pqs_create_quotation_from_pos(self._payload(**kwargs))
        return self.env['sale.order'].browse(result['id']), result

    def _expire(self, order):
        order.write({'pqs_expiry_datetime': fields.Datetime.now() - timedelta(hours=1)})

    def _enable_validity(self, mode):
        self.config.write({
            'pqs_validity_enabled': True,
            'pqs_validity_duration': 2,
            'pqs_validity_unit': 'hours',
            'pqs_expiry_mode': mode,
        })

    def _settlement_line(self, sol, price, discount=0.0):
        return {
            'product_id': sol.product_id.id,
            'qty': sol.product_uom_qty,
            'price_unit': price,
            'discount': discount,
            'sale_order_origin_id': {'id': sol.order_id.id},
            'sale_order_line_id': {'id': sol.id},
        }

    def _validate(self, lines):
        return self.env['pos.order'].pqs_validate_settlement(
            self.config.id, self.config.pricelist_id.id, lines)

    def _ui_settlement_order(self, sale_order, price):
        """Mock the POS UI data (18.0 format) of an order settling ``sale_order``."""
        sale_lines = sale_order.order_line
        data = self.create_ui_order_data(
            [(line.product_id, line.product_uom_qty) for line in sale_lines])
        commands = [list(command) for command in data['lines']]
        total = 0.0
        for command, sol in zip(commands, sale_lines):
            subtotal = price * sol.product_uom_qty
            command[2].update({
                'price_unit': price,
                'discount': 0.0,
                'price_subtotal': subtotal,
                'price_subtotal_incl': subtotal,
                'sale_order_origin_id': sale_order.id,
                'sale_order_line_id': sol.id,
                'pqs_repriced': price != sol.price_unit,
            })
            total += subtotal
        data['lines'] = commands
        data['partner_id'] = sale_order.partner_id.id
        data['state'] = 'paid'
        data.update(amount_total=total, amount_paid=total, amount_tax=0.0, amount_return=0.0)
        payments = [list(command) for command in data['payment_ids']][:1]
        payments[0][2]['amount'] = total
        data['payment_ids'] = payments
        return data

    # ------------------------------------------------------------------
    # configuration
    # ------------------------------------------------------------------
    def test_settings_defaults_and_dependency(self):
        config = self.env['pos.config'].create({'name': 'Fresh Shop'})
        self.assertFalse(config.pqs_quotation_enabled)
        self.assertFalse(config.pqs_validity_enabled)
        self.assertEqual(config.pqs_expiry_mode, 'alert')
        config.pqs_validity_enabled = True
        # Validity depends on quotation creation being enabled.
        self.assertFalse(config._pqs_validity_active())
        config.pqs_quotation_enabled = True
        self.assertTrue(config._pqs_validity_active())
        with self.assertRaises(ValidationError):
            config.pqs_validity_duration = 0

    # ------------------------------------------------------------------
    # creation
    # ------------------------------------------------------------------
    def test_create_quotation_assignments_without_payment(self):
        order, result = self._create_quotation(price=80.0, qty=2.0)
        self.assertEqual(order.state, 'draft')
        self.assertEqual(order.partner_id, self.pqs_partner)
        self.assertEqual(order.user_id, self.env.user)
        self.assertEqual(order.team_id, self.pqs_team)
        self.assertEqual(order.tag_ids.mapped('name'), [self.config.name])
        self.assertEqual(order.pqs_pos_config_id, self.config)
        self.assertEqual(order.pqs_pos_session_id, self.session)
        self.assertEqual(order.order_line.price_unit, 80.0)
        self.assertEqual(order.order_line.product_uom_qty, 2.0)
        self.assertAlmostEqual(order.amount_total, 160.0)
        # No POS sale and no payment were recorded.
        self.assertFalse(self.env['pos.order'].search([('session_id', '=', self.session.id)]))
        self.assertFalse(self.env['pos.payment'].search([('session_id', '=', self.session.id)]))
        self.assertFalse(order.invoice_ids)
        # Receipt data: quotation, no payment lines, downloadable PDF.
        self.assertTrue(result['is_quotation'])
        self.assertEqual(result['payment_lines'], [])
        self.assertEqual(result['name'], order.name)
        self.assertEqual(result['tags'], self.config.name)
        self.assertEqual(result['team'], self.pqs_team.name)
        self.assertIn('access_token=%s' % order.access_token, result['pdf_url'])
        self.assertFalse(result['salesperson_fallback'])

    def test_shop_tag_reused_case_insensitive(self):
        existing = self.env['crm.tag'].create({'name': self.config.name.upper()})
        order, _result = self._create_quotation()
        self.assertEqual(order.tag_ids, existing)
        order2, _result = self._create_quotation()
        self.assertEqual(order2.tag_ids, existing)
        self.assertEqual(
            self.env['crm.tag'].search_count([('name', '=ilike', self.config.name)]), 1)

    def test_shop_tag_created_when_missing(self):
        self.env['crm.tag'].search([('name', '=ilike', self.config.name)]).unlink()
        order, _result = self._create_quotation()
        self.assertEqual(order.tag_ids.name, self.config.name)

    def test_create_is_idempotent_per_cart(self):
        order1, _r = self._create_quotation(uid='0001-001-0001')
        order2, _r = self._create_quotation(uid='0001-001-0001')
        self.assertEqual(order1, order2)

    def test_creation_validations(self):
        SaleOrder = self.env['sale.order']
        with self.assertRaises(UserError):
            SaleOrder.pqs_create_quotation_from_pos(self._payload(partner_id=False))
        with self.assertRaises(UserError):
            SaleOrder.pqs_create_quotation_from_pos(self._payload(lines=[]))
        with self.assertRaises(UserError):
            SaleOrder.pqs_create_quotation_from_pos(self._payload(qty=-1.0))
        bad_discount = self._payload()
        bad_discount['lines'][0]['discount'] = 150.0
        with self.assertRaises(UserError):
            SaleOrder.pqs_create_quotation_from_pos(bad_discount)
        with self.assertRaises(UserError):
            SaleOrder.pqs_create_quotation_from_pos(self._payload(price=-10.0))
        other_pricelist = self.env['product.pricelist'].create({
            'name': 'Not in this shop',
            'currency_id': self.config.currency_id.id,
        })
        with self.assertRaises(UserError):
            SaleOrder.pqs_create_quotation_from_pos(self._payload(pricelist_id=other_pricelist.id))
        self.config.pqs_quotation_enabled = False
        with self.assertRaises(UserError):
            SaleOrder.pqs_create_quotation_from_pos(self._payload())

    def test_salesperson_from_employee_and_fallback(self):
        if 'hr.employee' not in self.env:
            self.skipTest('hr is not installed')
        seller = self.env['res.users'].create({
            'name': 'POS Seller',
            'login': 'pqs_pos_seller',
            'company_id': self.config.company_id.id,
            'company_ids': [(6, 0, self.config.company_id.ids)],
            'groups_id': [(6, 0, [self.env.ref('base.group_user').id])],
        })
        mapped = self.env['hr.employee'].create({'name': 'Mapped Cashier', 'user_id': seller.id})
        unmapped = self.env['hr.employee'].create({'name': 'Unmapped Cashier'})

        order, result = self._create_quotation(employee_id=mapped.id)
        self.assertEqual(order.user_id, seller)
        self.assertFalse(result['salesperson_fallback'])

        self.config.pqs_salesperson_fallback = 'current_user'
        order, result = self._create_quotation(employee_id=unmapped.id)
        self.assertEqual(order.user_id, self.env.user)
        self.assertTrue(result['salesperson_fallback'])

        self.config.pqs_salesperson_fallback = 'block'
        with self.assertRaises(UserError):
            self._create_quotation(employee_id=unmapped.id)

    def test_quotation_pdf_generation(self):
        order, result = self._create_quotation()
        content, filename = order._pqs_render_quotation_pdf()
        if isinstance(content, str):
            content = content.encode()
        self.assertTrue(content)
        self.assertIn(order.name.encode(), content)
        self.assertTrue(filename.endswith('.pdf'))
        self.assertEqual(result['pdf_filename'], filename)

    def test_validity_is_stamped(self):
        self._enable_validity('alert')
        before = fields.Datetime.now()
        order, result = self._create_quotation()
        self.assertTrue(order.pqs_expiry_datetime)
        self.assertGreaterEqual(order.pqs_expiry_datetime, before + timedelta(hours=2) - timedelta(seconds=5))
        self.assertTrue(order.validity_date)
        self.assertTrue(result['expiry_display'])
        check = order.pqs_check_pos_settlement(self.config.id)
        self.assertFalse(check['expired'])
        self.assertFalse(check['blocked'])

    # ------------------------------------------------------------------
    # settlement governance
    # ------------------------------------------------------------------
    def test_expired_alert_only_allows_original_prices(self):
        self._enable_validity('alert')
        order, _result = self._create_quotation(price=80.0)
        self._expire(order)
        check = order.pqs_check_pos_settlement(self.config.id)
        self.assertTrue(check['expired'])
        self.assertFalse(check['blocked'])
        self.assertEqual(check['mode'], 'alert')
        self.assertTrue(check['message'])

        res = self._validate([self._settlement_line(order.order_line, 80.0)])
        self.assertTrue(res['ok'], res['messages'])

        self.env['pos.order'].sync_from_ui([self._ui_settlement_order(order, 80.0)])
        pos_order = self.env['pos.order'].search([('session_id', '=', self.session.id)])
        self.assertEqual(len(pos_order), 1)
        self.assertEqual(pos_order.lines.sale_order_origin_id, order)
        self.assertIn('expired', ' '.join(order.message_ids.mapped('body')))

    def test_expired_block_mode_requires_current_price(self):
        self._enable_validity('block')
        order, _result = self._create_quotation(price=80.0)
        self._expire(order)
        check = order.pqs_check_pos_settlement(self.config.id)
        self.assertTrue(check['expired'])
        self.assertEqual(check['mode'], 'block')
        self.assertEqual(check['prices'], {str(order.order_line.id): 100.0})

        sol = order.order_line
        # Original price, any other price (issue: 0.01 workaround) and a
        # discount on the current price are all refused.
        for price, discount in ((80.0, 0.0), (50.0, 0.0), (80.01, 0.0), (100.0, 5.0)):
            res = self._validate([self._settlement_line(sol, price, discount)])
            self.assertFalse(res['ok'], (price, discount))
        with self.assertRaises(UserError):
            self.env['pos.order'].sync_from_ui([self._ui_settlement_order(order, 50.0)])

        # Down payment based on the original amount is rejected too.
        res = self._validate([{
            'product_id': self.pqs_down_payment.id,
            'qty': 1.0,
            'price_unit': 50.0,
            'discount': 0.0,
            'sale_order_origin_id': {'id': order.id},
            'sale_order_line_id': False,
        }])
        self.assertFalse(res['ok'])

    def test_expired_block_mode_allows_down_payment_deduction(self):
        # 18.0 adds a negative down-payment line to deduct what was already
        # paid: that is not a new down payment and must be accepted.
        self._enable_validity('block')
        order, _result = self._create_quotation(price=100.0)
        self._expire(order)
        res = self._validate([
            self._settlement_line(order.order_line, 100.0),
            {
                'product_id': self.pqs_down_payment.id,
                'qty': 1.0,
                'price_unit': -50.0,
                'discount': 0.0,
                'sale_order_origin_id': order.id,
                'sale_order_line_id': False,
            },
        ])
        self.assertTrue(res['ok'], res['messages'])

    def test_expired_block_mode_settles_at_current_price_and_updates_quotation(self):
        self._enable_validity('block')
        order, _result = self._create_quotation(price=80.0, qty=2.0)
        self._expire(order)
        res = self._validate([self._settlement_line(order.order_line, 100.0)])
        self.assertTrue(res['ok'], res['messages'])
        self.env['pos.order'].sync_from_ui([self._ui_settlement_order(order, 100.0)])
        pos_order = self.env['pos.order'].search([('session_id', '=', self.session.id)])
        self.assertEqual(len(pos_order), 1)
        self.assertTrue(pos_order.lines.pqs_repriced)
        # The quotation total now matches what was collected.
        self.assertEqual(order.order_line.price_unit, 100.0)
        self.assertAlmostEqual(order.amount_total, pos_order.amount_total)
        self.assertIn('re-priced', ' '.join(order.message_ids.mapped('body')))

    def test_expired_block_mode_uses_server_side_current_price(self):
        # The product price changes in the backend after the POS loaded it.
        self._enable_validity('block')
        order, _result = self._create_quotation(price=80.0)
        self._expire(order)
        self.pqs_product.lst_price = 120.0
        check = order.pqs_check_pos_settlement(self.config.id)
        self.assertEqual(check['prices'][str(order.order_line.id)], 120.0)
        self.assertFalse(self._validate([self._settlement_line(order.order_line, 100.0)])['ok'])
        self.assertTrue(self._validate([self._settlement_line(order.order_line, 120.0)])['ok'])

    def test_expired_block_mode_uses_quotation_pricelist(self):
        # A pricelist the shop does not load (-20%) still prices the quotation.
        pricelist = self.env['product.pricelist'].create({
            'name': 'PQS -20%',
            'currency_id': self.config.currency_id.id,
            'item_ids': [(0, 0, {
                'applied_on': '3_global',
                'compute_price': 'percentage',
                'percent_price': 20.0,
            })],
        })
        self._enable_validity('block')
        order, _result = self._create_quotation(price=70.0)
        order.pricelist_id = pricelist
        self._expire(order)
        check = order.pqs_check_pos_settlement(self.config.id)
        self.assertEqual(check['prices'][str(order.order_line.id)], 80.0)
        self.assertFalse(self._validate([self._settlement_line(order.order_line, 100.0)])['ok'])
        self.assertTrue(self._validate([self._settlement_line(order.order_line, 80.0)])['ok'])

    def test_expired_block_mode_unchanged_price_is_allowed(self):
        # The quotation price equals the current price: settling is allowed.
        self._enable_validity('block')
        order, _result = self._create_quotation(price=100.0)
        self._expire(order)
        res = self._validate([self._settlement_line(order.order_line, 100.0)])
        self.assertTrue(res['ok'], res['messages'])

    def test_not_expired_block_mode_keeps_original_prices(self):
        self._enable_validity('block')
        order, _result = self._create_quotation(price=80.0)
        check = order.pqs_check_pos_settlement(self.config.id)
        # Prices and expiry are sent anyway for the offline check.
        self.assertTrue(check['expiry'])
        self.assertTrue(check['prices'])
        res = self._validate([self._settlement_line(order.order_line, 80.0)])
        self.assertTrue(res['ok'], res['messages'])

    def test_sales_expiration_date_drives_pos_expiry(self):
        self._enable_validity('block')
        order, _result = self._create_quotation(price=80.0)
        today = fields.Date.context_today(order)
        # Extend in Sales: the POS expiry follows.
        order.validity_date = today + timedelta(days=5)
        self.assertEqual(order._pqs_local_date(order.pqs_expiry_datetime), today + timedelta(days=5))
        self.assertFalse(order.pqs_check_pos_settlement(self.config.id)['expired'])
        # Shorten in Sales: the quotation expires.
        order.validity_date = today - timedelta(days=1)
        self.assertTrue(order.pqs_check_pos_settlement(self.config.id)['expired'])
        # Same date again keeps the stamped time.
        stamped = order.pqs_expiry_datetime
        order.validity_date = today - timedelta(days=1)
        self.assertEqual(order.pqs_expiry_datetime, stamped)

    def test_sales_quotation_uses_its_expiration_date(self):
        self._enable_validity('block')
        order = self.env['sale.order'].create({
            'partner_id': self.pqs_partner.id,
            'pricelist_id': self.config.pricelist_id.id,
            'validity_date': fields.Date.context_today(self.env['sale.order']) - timedelta(days=1),
            'order_line': [(0, 0, {
                'product_id': self.pqs_product.id,
                'product_uom_qty': 1.0,
                'price_unit': 80.0,
            })],
        })
        self.assertTrue(order.pqs_check_pos_settlement(self.config.id)['expired'])
        self.assertFalse(self._validate([self._settlement_line(order.order_line, 80.0)])['ok'])

    def test_stock_check_before_settlement(self):
        order, _result = self._create_quotation(price=80.0, qty=2.0)
        line = self._settlement_line(order.order_line, 80.0)
        self.assertTrue(self._validate([line])['ok'])
        self.config.pqs_check_stock_before_settle = True
        res = self._validate([line])
        self.assertFalse(res['ok'])
        location = self.config.picking_type_id.default_location_src_id
        self.env['stock.quant']._update_available_quantity(self.pqs_product, location, 5.0)
        res = self._validate([line])
        self.assertTrue(res['ok'], res['messages'])

    def test_cancelled_and_settled_quotations_are_blocked(self):
        order, _result = self._create_quotation()
        order._action_cancel()
        check = order.pqs_check_pos_settlement(self.config.id)
        self.assertTrue(check['blocked'])
        self.assertFalse(self._validate([self._settlement_line(order.order_line, 80.0)])['ok'])

        order2, _result = self._create_quotation()
        order2.order_line.write({'qty_delivered': order2.order_line.product_uom_qty})
        check = order2.pqs_check_pos_settlement(self.config.id)
        self.assertTrue(check['blocked'])
        self.assertFalse(self._validate([self._settlement_line(order2.order_line, 80.0)])['ok'])
