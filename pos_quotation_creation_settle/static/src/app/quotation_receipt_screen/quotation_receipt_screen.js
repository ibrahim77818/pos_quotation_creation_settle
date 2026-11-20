import { Component, onMounted } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { usePos } from "@point_of_sale/app/hooks/pos_hook";
import { PQSQuotationReceipt } from "@pos_quotation_creation_settle/app/quotation_receipt/quotation_receipt";

export class PQSQuotationReceiptScreen extends Component {
    static template = "pos_quotation_creation_settle.QuotationReceiptScreen";
    static components = { PQSQuotationReceipt };
    static props = { orderUuid: { type: String } };

    setup() {
        this.pos = usePos();
        onMounted(() => {
            // Let the receipt render before printing / downloading.
            setTimeout(() => this._autoOutput(), 0);
        });
    }

    get order() {
        return this.pos.models["pos.order"].getBy("uuid", this.props.orderUuid);
    }

    get quotation() {
        return this.order?.uiState.pqsQuotation || null;
    }

    get receiptProps() {
        return {
            quotation: this.quotation,
            formatCurrency: this.env.utils.formatCurrency,
            logo: this.pos.config.receiptLogoUrl || "",
        };
    }

    async _autoOutput() {
        const quotation = this.quotation;
        if (!quotation) {
            this.newOrder();
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
        await this.pos.pqsPrintQuotation(this.quotation);
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
        const order = this.order;
        if (order && order.uiState.pqsQuotation) {
            // The cart became a quotation: it must not be paid afterwards.
            this.pos.removeOrder(order);
        }
        const next = this.pos.addNewOrder();
        this.pos.navigate("ProductScreen", { orderUuid: next.uuid });
    }
}

registry.category("pos_pages").add("PQSQuotationReceiptScreen", {
    name: "PQSQuotationReceiptScreen",
    component: PQSQuotationReceiptScreen,
    route: `/pos/ui/${odoo.pos_config_id}/pqs-quotation/{string:orderUuid}`,
    params: {
        orderUuid: true,
    },
});
