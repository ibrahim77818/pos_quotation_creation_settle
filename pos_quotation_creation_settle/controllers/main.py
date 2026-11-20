# -*- coding: utf-8 -*-
import hmac

from odoo import http
from odoo.http import request

try:
    from odoo.http import content_disposition
except ImportError:  # Odoo 20 moved it into odoo.http.stream
    from odoo.http.stream import content_disposition


class PosQuotationController(http.Controller):

    @http.route('/pos_quotation_creation_settle/quotation/<int:order_id>/pdf',
                type='http', auth='user', methods=['GET'])
    def pqs_quotation_pdf(self, order_id, access_token=None, **kwargs):
        """Download the quotation PDF for a quotation created from the POS.

        POS users may not have Sales access rights, so access is granted by
        the quotation's portal access token returned at creation time.
        """
        order = request.env['sale.order'].sudo().browse(order_id).exists()
        if (not order or not access_token or not order.access_token
                or not hmac.compare_digest(str(order.access_token), str(access_token))):
            raise request.not_found()
        content, filename = order._pqs_render_quotation_pdf()
        headers = [
            ('Content-Type', 'application/pdf'),
            ('Content-Length', len(content)),
            ('Content-Disposition', content_disposition(filename)),
        ]
        return request.make_response(content, headers=headers)
