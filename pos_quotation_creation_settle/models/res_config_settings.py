# -*- coding: utf-8 -*-
from odoo import fields, models


class ResConfigSettings(models.TransientModel):
    _inherit = 'res.config.settings'

    pos_pqs_quotation_enabled = fields.Boolean(
        related='pos_config_id.pqs_quotation_enabled', readonly=False)
    pos_pqs_validity_enabled = fields.Boolean(
        related='pos_config_id.pqs_validity_enabled', readonly=False)
    pos_pqs_validity_duration = fields.Integer(
        related='pos_config_id.pqs_validity_duration', readonly=False)
    pos_pqs_validity_unit = fields.Selection(
        related='pos_config_id.pqs_validity_unit', readonly=False)
    pos_pqs_expiry_mode = fields.Selection(
        related='pos_config_id.pqs_expiry_mode', readonly=False)
    pos_pqs_salesperson_fallback = fields.Selection(
        related='pos_config_id.pqs_salesperson_fallback', readonly=False)
    pos_pqs_auto_download_pdf = fields.Boolean(
        related='pos_config_id.pqs_auto_download_pdf', readonly=False)
    pos_pqs_check_stock_before_settle = fields.Boolean(
        related='pos_config_id.pqs_check_stock_before_settle', readonly=False)
