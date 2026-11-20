import { Component, onMounted } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { usePos } from "@point_of_sale/app/store/pos_hook";
import { PQSQuotationReceipt } from "@pos_quotation_creation_settle/app/quotation_receipt/quotation_receipt";

export class PQSQuotationReceiptScreen extends Component {
    static template = "pos_quotation_creation_settle.QuotationReceiptScreen";
    static components = { PQSQuotationReceipt };
    static props = { quotation: { type: Object, optional: true } };

    setup() {
        this.pos = usePos();
        onMounted(() => {
            // Let the receipt render before printing / downloading.
            setTimeout(() => this._autoOutput(), 0);
        });
    }

    get quotation() {
        return this.props.quotation || this.pos.get_order()?.uiState.pqsQuotation || null;
    }

    get receiptProps() {
        return {
            quotation: this.quotation,
            formatCurrency: this.env.utils.formatCurrency,
            logo: this.pos.company_logo_base64 || "",
        };
    }

    async _autoOutput() {
        const quotation = this.quotation;
        if (!quotation) {
            this.pos.showScreen("ProductScreen");
            return;
        }
        // Only once per quotation (not again after a reload).
        if (quotation.pqs_auto_done) {
            return;
        }
        quotation.pqs_auto_done = true;
        if (this.pos.config.pqs_auto_download_pdf) {
            this.downloadPdf();
        }
        if (this.pos.config.iface_print_auto) {
            await this.printReceipt();
        }
    }

    async printReceipt() {
        await this.pos.printer.print(PQSQuotationReceipt, this.receiptProps, {
            webPrintFallback: true,
        });
    }

    downloadPdf() {
        const quotation = this.quotation;
        if (!quotation || !quotation.pdf_url) {
            return;
        }
        const link = document.createElement("a");
        link.href = quotation.pdf_url;
        link.download = quotation.pdf_filename || `${quotation.name}.pdf`;
        link.rel = "noopener";
        document.body.appendChild(link);
        link.click();
        link.remove();
    }

    newOrder() {
        const order = this.pos.get_order();
        if (order && order.uiState.pqsQuotation) {
            // The cart became a quotation: it must not be paid afterwards.
            this.pos.removeOrder(order);
            this.pos.add_new_order();
        } else if (!order) {
            this.pos.add_new_order();
        }
        this.pos.showScreen("ProductScreen");
    }
}

registry.category("pos_screens").add("PQSQuotationReceiptScreen", PQSQuotationReceiptScreen);
