# -*- coding: utf-8 -*-
{
    'name': 'POS Quotation Creation & Validity-Governed Settlement',
    'version': '20.0.1.2.3',
    'category': 'Sales/Point of Sale',
    'summary': 'Create Sales quotations from the POS cart (no payment), print a '
               'quotation receipt and PDF, and govern settlement of expired '
               'quotations through the Quotation/Order flow.',
    'description': """
POS Quotation Creation & Settlement Governance
==============================================
* "Create Quotation" button on the POS product screen (per POS toggle).
* Creates a sale.order quotation without any POS payment.
* Auto-assigns a Sales tag named after the POS shop, the active cashier's
  user as salesperson (with configurable fallback) and the POS Sales Team.
* Prints a POS quotation receipt (no payment lines) and downloads the
  Quotation PDF.
* Optional validity period (hours/days) with expiry governance when the
  quotation is settled through Quotation/Order:
  Alert Only or Block Same-Price Settlement (re-price at current prices).
* Server-side enforcement: cancelled, fully settled or expired same-price
  quotations cannot be synchronised.
* English and Arabic.
Works with Odoo 20 Community and Enterprise.
""",
    'author': 'Ibrahim Yahia',
    'website': 'https://www.linkedin.com/in/ibrahim-yahia',
    'license': 'LGPL-3',
    'depends': ['pos_sale'],
    'data': [
        'views/res_config_settings_views.xml',
        'views/sale_order_views.xml',
        'views/pos_order_views.xml',
        'report/sale_report_templates.xml',
        'receipt/pos_quotation_receipt.xml',
    ],
    'assets': {
        'point_of_sale._assets_pos': [
            'pos_quotation_creation_settle/static/src/css/pos_quotation.css',
            'pos_quotation_creation_settle/static/src/app/**/*',
        ],
    },
    'images': ['static/description/banner.png'],
    'installable': True,
    'application': False,
    'auto_install': False,
}
