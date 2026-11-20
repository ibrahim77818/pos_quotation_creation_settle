odoo.define('pos_quotation_creation_settle.QuotationReceiptScreen', function (require) {
    'use strict';

    const AbstractReceiptScreen = require('point_of_sale.AbstractReceiptScreen');
    const Registries = require('point_of_sale.Registries');
    const { onMounted } = owl;

    class PQSQuotationReceiptScreen extends AbstractReceiptScreen {
        setup() {
            super.setup();
            onMounted(() => {
                // Let the receipt render before printing / downloading.
                setTimeout(() => this._autoOutput(), 0);
            });
        }

        get quotation() {
            if (this.props.quotation) {
                return this.props.quotation;
            }
            const order = this.env.pos.get_order();
            return (order && order.pqs_quotation) || null;
        }

        async _autoOutput() {
            const quotation = this.quotation;
            if (!quotation) {
                this.showScreen('ProductScreen');
                return;
            }
            // Only once per quotation (not again after a reload).
            if (quotation.pqs_auto_done) {
                return;
            }
            quotation.pqs_auto_done = true;
            const order = this.env.pos.get_order();
            if (order && order.pqs_quotation) {
                this.env.pos.db.save_unpaid_order(order);
            }
            if (this.env.pos.config.pqs_auto_download_pdf) {
                this.downloadPdf();
            }
            if (this.env.pos.config.iface_print_auto) {
                await this.printReceipt();
            }
        }

        async printReceipt() {
            await this._printReceipt();
        }

        downloadPdf() {
            const quotation = this.quotation;
            if (!quotation || !quotation.pdf_url) {
                return;
            }
            const link = document.createElement('a');
            link.href = quotation.pdf_url;
            link.download = quotation.pdf_filename || `${quotation.name}.pdf`;
            link.rel = 'noopener';
            document.body.appendChild(link);
            link.click();
            link.remove();
        }

        newOrder() {
            const order = this.env.pos.get_order();
            if (order && order.pqs_quotation) {
                // The cart became a quotation: it must not be paid afterwards.
                this.env.pos.removeOrder(order);
                this.env.pos.add_new_order();
            } else if (!order) {
                this.env.pos.add_new_order();
            }
            this.showScreen('ProductScreen');
        }
    }
    PQSQuotationReceiptScreen.template = 'PQSQuotationReceiptScreen';

    Registries.Component.add(PQSQuotationReceiptScreen);

    return PQSQuotationReceiptScreen;
});
