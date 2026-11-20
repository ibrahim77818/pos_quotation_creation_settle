# -*- coding: utf-8 -*-
from odoo import api, models


class IrUiView(models.Model):
    _inherit = 'ir.ui.view'

    @api.model
    def _get_xml_ids_to_load(self):
        # Make the quotation ticket available to the POS ticket printer.
        return super()._get_xml_ids_to_load() + [
            'pos_quotation_creation_settle.pos_quotation_receipt',
        ]
