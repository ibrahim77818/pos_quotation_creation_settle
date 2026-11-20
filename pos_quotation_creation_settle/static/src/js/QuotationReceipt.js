odoo.define('pos_quotation_creation_settle.QuotationReceipt', function (require) {
    'use strict';

    const PosComponent = require('point_of_sale.PosComponent');
    const Registries = require('point_of_sale.Registries');

    /**
     * POS receipt for a quotation. It is driven by the server data of the
     * created sale.order and deliberately has no payment / change section.
     */
    class PQSQuotationReceipt extends PosComponent {
        get quotation() {
            return this.props.quotation || {};
        }
        get companyLogo() {
            return this.env.pos.company_logo_base64 || false;
        }
        formatCurrency(amount) {
            return this.env.pos.format_currency(amount || 0);
        }
        formatQty(qty) {
            return String(parseFloat(Number(qty || 0).toFixed(3)));
        }
        hasDiscount(line) {
            return Number(line.discount || 0) > 0;
        }
    }
    PQSQuotationReceipt.template = 'PQSQuotationReceipt';

    Registries.Component.add(PQSQuotationReceipt);

    return PQSQuotationReceipt;
});
