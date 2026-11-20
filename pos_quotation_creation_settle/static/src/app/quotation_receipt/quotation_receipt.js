
import { Component } from "@odoo/owl";

/**
 * POS receipt for a quotation, driven by the server data of the created
 * sale.order. It has no payment / change section. It only uses its props,
 * because the printer service renders it outside the POS screen.
 */
export class PQSQuotationReceipt extends Component {
    static template = "pos_quotation_creation_settle.QuotationReceipt";
    static props = {
        quotation: Object,
        formatCurrency: Function,
        logo: { type: String, optional: true },
    };

    get quotation() {
        return this.props.quotation || {};
    }
    formatQty(qty) {
        return String(parseFloat(Number(qty || 0).toFixed(3)));
    }
    hasDiscount(line) {
        return Number(line.discount || 0) > 0;
    }
}
