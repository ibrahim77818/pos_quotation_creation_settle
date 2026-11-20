# -*- coding: utf-8 -*-
from odoo import models

PQS_CONFIG_FIELDS = [
    'pqs_quotation_enabled',
    'pqs_validity_enabled',
    'pqs_validity_duration',
    'pqs_validity_unit',
    'pqs_expiry_mode',
    'pqs_salesperson_fallback',
    'pqs_auto_download_pdf',
    'pqs_check_stock_before_settle',
    'down_payment_product_id',
    'currency_id',
]


class PosSession(models.Model):
    _inherit = 'pos.session'

    def _loader_params_pos_config(self):
        params = super()._loader_params_pos_config()
        fields_list = params.get('search_params', {}).get('fields')
        # An empty list means "all fields" in v16; only extend explicit lists.
        if fields_list:
            for fname in PQS_CONFIG_FIELDS:
                if fname not in fields_list:
                    fields_list.append(fname)
        return params
