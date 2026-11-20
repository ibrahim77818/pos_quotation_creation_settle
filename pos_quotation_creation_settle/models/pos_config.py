# -*- coding: utf-8 -*-
from datetime import timedelta

from odoo import _, api, fields, models
from odoo.exceptions import ValidationError


class PosConfig(models.Model):
    _inherit = 'pos.config'

    pqs_quotation_enabled = fields.Boolean(
        string='Create Quotation from POS',
        default=False,
        help='Show a "Create Quotation" button on the POS product screen. '
             'The cart is turned into a Sales quotation without any payment.')
    pqs_validity_enabled = fields.Boolean(
        string='Quotation Validity Period',
        default=False,
        help='Stamp an expiry on quotations created from this POS and check '
             'it when a quotation is settled through Quotation/Order.')
    pqs_validity_duration = fields.Integer(
        string='Validity Duration',
        default=7,
        help='How long a quotation stays valid after it is created.')
    pqs_validity_unit = fields.Selection(
        selection=[('hours', 'Hours'), ('days', 'Days')],
        string='Validity Unit',
        default='days',
        required=True)
    pqs_expiry_mode = fields.Selection(
        selection=[
            ('alert', 'Alert Only'),
            ('block', 'Block Same-Price Settlement'),
        ],
        string='Validity Expiry Governance',
        default='alert',
        required=True,
        help='Alert Only: warn the cashier but allow settlement at the '
             'original quotation prices.\n'
             'Block Same-Price Settlement: the expired quotation cannot be '
             'settled at its original prices; it can only be settled after '
             'being re-priced at the current POS prices.')
    pqs_salesperson_fallback = fields.Selection(
        selection=[
            ('current_user', 'Use the logged-in POS user'),
            ('block', 'Block quotation creation'),
        ],
        string='Cashier Without Linked User',
        default='current_user',
        required=True,
        help='What to do when the active cashier (employee) is not linked to '
             'an Odoo user that can be set as salesperson.')
    pqs_auto_download_pdf = fields.Boolean(
        string='Download Quotation PDF Automatically',
        default=True,
        help='Download the quotation PDF as soon as the quotation is created.')

    pqs_check_stock_before_settle = fields.Boolean(
        string='Check Stock Before Settlement',
        default=False,
        help='Before taking the payment of a Quotation/Order settlement, check '
             'that storable products are available in the POS stock location. '
             'Enable it when stock is restricted at synchronisation, so a paid '
             'order cannot get stuck in the sync queue.')

    @api.constrains('pqs_validity_enabled', 'pqs_validity_duration')
    def _check_pqs_validity_duration(self):
        for config in self:
            if config.pqs_validity_enabled and config.pqs_validity_duration <= 0:
                raise ValidationError(_(
                    'The quotation validity duration must be greater than zero.'))

    def _pqs_validity_active(self):
        """Validity governance is only active when quotation creation is on
        (the validity setting depends on it) and the period is configured."""
        self.ensure_one()
        return bool(
            self.pqs_quotation_enabled
            and self.pqs_validity_enabled
            and self.pqs_validity_duration > 0
        )

    def _pqs_validity_delta(self):
        self.ensure_one()
        if self.pqs_validity_unit == 'hours':
            return timedelta(hours=self.pqs_validity_duration)
        return timedelta(days=self.pqs_validity_duration)
