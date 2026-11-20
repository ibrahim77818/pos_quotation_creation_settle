import { _t } from "@web/core/l10n/translation";
import { patch } from "@web/core/utils/patch";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { PosStore } from "@point_of_sale/app/services/pos_store";
import { ask } from "@point_of_sale/app/utils/make_awaitable_dialog";
import { SelectionPopup } from "@point_of_sale/app/components/popups/selection_popup/selection_popup";
import { isConnectionError, serverErrorMessage } from "@pos_quotation_creation_settle/app/utils";

/**
 * Both flows live on the store, not on a component: the buttons are in the
 * "Actions" dialog, which may be closed while our own dialogs are open.
 */
patch(PosStore.prototype, {
    // ------------------------------------------------------------------
    // Create Quotation
    // ------------------------------------------------------------------
    async pqsCreateQuotation() {
        if (this._pqsBusy) {
            return;
        }
        const order = this.getOrder();
        if (!order) {
            return;
        }
        // The cart was already turned into a quotation: show it again.
        if (order.uiState.pqsQuotation) {
            this.navigate("PQSQuotationReceiptScreen", { orderUuid: order.uuid });
            return;
        }
        if (!this._pqsCheckCart(order)) {
            return;
        }
        let partner = order.getPartner();
        if (!partner) {
            const select = await ask(this.dialog, {
                title: _t("Customer Required"),
                body: _t("A quotation needs a customer. Do you want to select one now?"),
                confirmLabel: _t("Select Customer"),
                cancelLabel: _t("Cancel"),
            });
            if (!select) {
                return;
            }
            await this.selectPartner();
            partner = order.getPartner();
            if (!partner) {
                return;
            }
        }
        const confirmed = await ask(this.dialog, {
            title: _t("Create Quotation"),
            body: _t(
                "Create a quotation for %s? No payment will be recorded and the cart will be closed.",
                partner.name
            ),
            confirmLabel: _t("Create Quotation"),
            cancelLabel: _t("Cancel"),
        });
        if (!confirmed) {
            return;
        }
        this._pqsBusy = true;
        try {
            const result = await this.data.call("sale.order", "pqs_create_quotation_from_pos", [
                this._pqsQuotationPayload(order, partner),
            ]);
            order.uiState.pqsQuotation = Object.assign({}, result, { pqs_auto_done: false });
            if (result.salesperson_fallback) {
                this.notification.add(
                    _t("The cashier has no linked user: %s was set as salesperson.", result.salesperson),
                    { type: "warning" }
                );
            }
            this.navigate("PQSQuotationReceiptScreen", { orderUuid: order.uuid });
        } catch (error) {
            this._pqsHandleError(error, _t("Cannot Create Quotation"), _t(
                "The quotation could not be created because the server is unreachable. Please try again when the connection is restored."
            ));
        } finally {
            this._pqsBusy = false;
        }
    },

    _pqsCheckCart(order) {
        const lines = order.getOrderlines();
        let body = "";
        if (!lines.length) {
            body = _t("The cart is empty. Add products before creating a quotation.");
        } else if (lines.some((line) => line.sale_order_origin_id)) {
            body = _t(
                "This cart contains lines loaded from an existing quotation or sales order. Settle it with a payment, or start a new cart to create a quotation."
            );
        } else if (lines.some((line) => line.refunded_orderline_id || line.getQuantity() <= 0)) {
            body = _t("Quotations cannot contain refund or zero-quantity lines.");
        } else if (lines.some((line) => line.price_unit < 0 || line.getDiscount() > 100)) {
            body = _t(
                "Quotations cannot contain negative prices or discounts above 100%. Remove reward or discount lines first."
            );
        } else if (order.payment_ids.length) {
            body = _t("Remove the payment lines before creating a quotation.");
        }
        if (body) {
            this.dialog.add(AlertDialog, { title: _t("Cannot Create Quotation"), body });
            return false;
        }
        return true;
    },

    _pqsQuotationPayload(order, partner) {
        const cashier = this.accessRight.cashier;
        // With pos_hr the cashier is an employee (resolved to its user
        // server-side); otherwise the cashier is the logged-in user.
        const isEmployee = cashier?.model?.modelName === "hr.employee";
        return {
            config_id: this.config.id,
            session_id: this.session.id,
            uid: order.uuid,
            partner_id: partner.id,
            pricelist_id: order.pricelist_id ? order.pricelist_id.id : false,
            fiscal_position_id: order.fiscal_position_id ? order.fiscal_position_id.id : false,
            employee_id: isEmployee ? cashier.id : false,
            lines: order.getOrderlines().map((line) => ({
                product_id: line.product_id.id,
                qty: line.getQuantity(),
                price_unit: line.price_unit,
                discount: line.getDiscount(),
                customer_note: line.customer_note || "",
            })),
        };
    },

    /** Print the quotation ticket through the 20.0 ticket printer. */
    async pqsPrintQuotation(quotation) {
        const fmt = (amount) => this.env.utils.formatCurrency(amount || 0);
        const qty = (value) => String(parseFloat(Number(value || 0).toFixed(3)));
        const data = {
            image: { logo: this.config.receiptLogoUrl },
            quotation: {
                ...quotation,
                lines: (quotation.lines || []).map((line) => ({
                    ...line,
                    qty_label: `${qty(line.qty)} ${line.uom || ""} x ${fmt(line.price_unit)}`,
                    subtotal_label: fmt(line.price_subtotal),
                    discount_label: Number(line.discount || 0) > 0 ? `${line.discount}%` : "",
                })),
                amount_untaxed_label: fmt(quotation.amount_untaxed),
                amount_tax_label: fmt(quotation.amount_tax),
                amount_total_label: fmt(quotation.amount_total),
            },
        };
        const iframe = await this.ticketPrinter.generateIframe(
            "pos_quotation_creation_settle.pos_quotation_receipt",
            data
        );
        return await this.ticketPrinter.printWithFallback({ iframe, webFallback: true });
    },

    _pqsHandleError(error, title, offlineBody) {
        if (isConnectionError(error)) {
            this.dialog.add(AlertDialog, { title: _t("Network Error"), body: offlineBody });
            return;
        }
        const message = serverErrorMessage(error);
        if (message) {
            this.dialog.add(AlertDialog, { title, body: message });
            return;
        }
        throw error;
    },

    // ------------------------------------------------------------------
    // Quotation/Order settlement governance
    // ------------------------------------------------------------------
    async onClickSaleOrder(clickedOrderId) {
        let check;
        try {
            check = await this.data.call("sale.order", "pqs_check_pos_settlement", [
                [clickedOrderId],
                this.config.id,
            ]);
        } catch (error) {
            this._pqsHandleError(error, _t("Quotation Cannot Be Settled"), _t(
                "The quotation validity could not be checked because the server is unreachable."
            ));
            return;
        }
        if (check.blocked) {
            this.dialog.add(AlertDialog, {
                title: _t("Quotation Cannot Be Settled"),
                body: check.message,
            });
            return;
        }

        if (check.expired && check.mode === "block") {
            const confirmed = await ask(this.dialog, {
                title: _t("Expired Quotation: Original Prices Blocked"),
                body: `${check.message} ${_t(
                    "The quotation lines will be re-priced at the current prices and their discounts removed. Down payments are not available for expired quotations."
                )}`,
                confirmLabel: _t("Settle at Current Prices"),
                cancelLabel: _t("Cancel"),
            });
            if (!confirmed) {
                return;
            }
            const before = new Set(this.getOrder()?.lines || []);
            const result = await this._pqsSettleWithoutDownPayment(clickedOrderId);
            this._pqsAfterSettlement(check, before, true);
            return result;
        }

        if (check.expired) {
            // Alert Only
            const confirmed = await ask(this.dialog, {
                title: _t("Expired Quotation"),
                body: `${check.message} ${_t("Do you want to continue with the settlement?")}`,
                confirmLabel: _t("Continue Settlement"),
                cancelLabel: _t("Cancel"),
            });
            if (!confirmed) {
                return;
            }
        }
        const before = new Set(this.getOrder()?.lines || []);
        const result = await super.onClickSaleOrder(...arguments);
        this._pqsAfterSettlement(check, before, false);
        return result;
    },

    /**
     * Run the native flow but answer its "settle / down payment" choice with
     * "settle": a down payment on an expired quotation in Block mode would be
     * based on the original amount.
     */
    async _pqsSettleWithoutDownPayment(clickedOrderId) {
        const dialog = this.dialog;
        this.dialog = Object.assign(Object.create(dialog), {
            add: (component, props, options) => {
                if (
                    component === SelectionPopup &&
                    (props?.list || []).some((option) => option.item === "settle")
                ) {
                    props.getPayload("settle");
                    return () => {};
                }
                return dialog.add(component, props, options);
            },
        });
        try {
            return await super.onClickSaleOrder(clickedOrderId);
        } finally {
            this.dialog = dialog;
        }
    },

    _pqsAfterSettlement(check, before, reprice) {
        const order = this.getOrder();
        if (!order) {
            return;
        }
        const added = order.lines.filter(
            (line) => !before.has(line) && line.sale_order_origin_id?.id === check.order_id
        );
        if (!added.length) {
            return; // the settlement was cancelled in the native flow
        }
        order.uiState.pqsChecks = Object.assign({}, order.uiState.pqsChecks || {}, {
            [check.order_id]: {
                name: check.name,
                mode: check.mode,
                expiry: check.expiry || false,
                prices: check.prices || {},
            },
        });
        if (!reprice) {
            return;
        }
        const dpId = this.config.down_payment_product_id?.id;
        let repriced = 0;
        let removedDownPayment = false;
        for (const line of added) {
            const sol = line.sale_order_line_id;
            if (!sol) {
                if (dpId && line.product_id.id === dpId && line.price_unit > 0) {
                    line.delete();
                    removedDownPayment = true;
                }
                continue;
            }
            if (sol.is_downpayment) {
                continue; // deduction of an earlier down payment
            }
            const price = (check.prices || {})[String(sol.id)];
            if (price === undefined) {
                continue; // the payment screen will refuse it
            }
            // Server price (quotation pricelist, today's product prices),
            // kept fixed so a quantity change does not re-price it.
            line.setDiscount(0);
            line.setUnitPrice(price);
            line.price_type = "manual";
            line.pqs_repriced = true;
            repriced += 1;
        }
        if (removedDownPayment) {
            this.dialog.add(AlertDialog, {
                title: _t("Down Payment Not Allowed"),
                body: _t(
                    "Down payments are not available for expired quotations in Block mode. The down-payment line was removed."
                ),
            });
        } else if (repriced) {
            this.notification.add(
                _t("Expired quotation: lines were re-priced at the current prices."),
                { type: "info" }
            );
        }
    },
});
