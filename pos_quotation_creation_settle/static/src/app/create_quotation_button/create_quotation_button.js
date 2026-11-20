/** @odoo-module */

import { Component } from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";
import { usePos } from "@point_of_sale/app/store/pos_hook";
import { ProductScreen } from "@point_of_sale/app/screens/product_screen/product_screen";
import { ErrorPopup } from "@point_of_sale/app/errors/popups/error_popup";
import { ConfirmPopup } from "@point_of_sale/app/utils/confirm_popup/confirm_popup";
import { isConnectionError, serverErrorMessage } from "@pos_quotation_creation_settle/app/utils";

export class PQSCreateQuotationButton extends Component {
    static template = "pos_quotation_creation_settle.CreateQuotationButton";

    setup() {
        this.pos = usePos();
        // Raw services, not useService(): in the narrow layout this button
        // lives in the "More..." popup, which is destroyed while our dialogs
        // are open. useService() refuses calls from a destroyed component
        // ("Component is destroyed"), so the flow must not depend on it.
        const services = this.env.services;
        this.popup = services.popup;
        this.orm = services.orm;
        this.notification = services.pos_notification;
        this.busy = false;
    }

    async onClick() {
        if (this.busy) {
            return;
        }
        const order = this.pos.get_order();
        if (!order) {
            return;
        }
        // The cart was already turned into a quotation: show it again.
        if (order.pqs_quotation) {
            this.pos.showScreen("PQSQuotationReceiptScreen", { quotation: order.pqs_quotation });
            return;
        }
        if (!(await this._checkCart(order))) {
            return;
        }
        const partner = await this._ensurePartner(order);
        if (!partner) {
            return;
        }
        const { confirmed } = await this.popup.add(ConfirmPopup, {
            title: _t("Create Quotation"),
            body: _t(
                "Create a quotation for %s? No payment will be recorded and the cart will be closed.",
                partner.name
            ),
            confirmText: _t("Create Quotation"),
            cancelText: _t("Cancel"),
        });
        if (!confirmed) {
            return;
        }
        this.busy = true;
        try {
            const result = await this.orm.call("sale.order", "pqs_create_quotation_from_pos", [
                this._buildPayload(order, partner),
            ]);
            order.pqs_quotation = Object.assign({}, result, { pqs_auto_done: false });
            if (result.salesperson_fallback) {
                this.notification.add(
                    _t("The cashier has no linked user: %s was set as salesperson.", result.salesperson),
                    5000
                );
            }
            this.pos.showScreen("PQSQuotationReceiptScreen", { quotation: order.pqs_quotation });
        } catch (error) {
            await this._handleError(error);
        } finally {
            this.busy = false;
        }
    }

    async _checkCart(order) {
        const lines = order.get_orderlines();
        let body = "";
        if (!lines.length) {
            body = _t("The cart is empty. Add products before creating a quotation.");
        } else if (lines.some((line) => line.sale_order_origin_id)) {
            body = _t(
                "This cart contains lines loaded from an existing quotation or sales order. Settle it with a payment, or start a new cart to create a quotation."
            );
        } else if (lines.some((line) => line.refunded_orderline_id || line.get_quantity() <= 0)) {
            body = _t("Quotations cannot contain refund or zero-quantity lines.");
        } else if (lines.some((line) => line.get_unit_price() < 0 || line.get_discount() > 100)) {
            body = _t(
                "Quotations cannot contain negative prices or discounts above 100%. Remove reward or discount lines first."
            );
        } else if (order.get_paymentlines().length) {
            body = _t("Remove the payment lines before creating a quotation.");
        }
        if (body) {
            await this.popup.add(ErrorPopup, { title: _t("Cannot Create Quotation"), body });
            return false;
        }
        return true;
    }

    async _ensurePartner(order) {
        if (order.get_partner()) {
            return order.get_partner();
        }
        const { confirmed } = await this.popup.add(ConfirmPopup, {
            title: _t("Customer Required"),
            body: _t("A quotation needs a customer. Do you want to select one now?"),
            confirmText: _t("Select Customer"),
            cancelText: _t("Cancel"),
        });
        if (!confirmed) {
            return false;
        }
        await this.pos.selectPartner();
        return order.get_partner() || false;
    }

    _buildPayload(order, partner) {
        const pos = this.pos;
        const cashier = pos.get_cashier();
        // With pos_hr the cashier is an employee (resolved to its user
        // server-side); otherwise the cashier is the logged-in user.
        const isEmployee = Boolean(pos.config.module_pos_hr && pos.employees && cashier);
        return {
            config_id: pos.config.id,
            session_id: pos.pos_session.id,
            uid: order.uid,
            partner_id: partner.id,
            pricelist_id: order.pricelist ? order.pricelist.id : false,
            fiscal_position_id: order.fiscal_position ? order.fiscal_position.id : false,
            employee_id: isEmployee ? cashier.id : false,
            lines: order.get_orderlines().map((line) => ({
                product_id: line.get_product().id,
                qty: line.get_quantity(),
                price_unit: line.get_unit_price(),
                discount: line.get_discount(),
                customer_note: line.get_customer_note() || "",
            })),
        };
    }

    async _handleError(error) {
        if (isConnectionError(error)) {
            await this.popup.add(ErrorPopup, {
                title: _t("Network Error"),
                body: _t(
                    "The quotation could not be created because the server is unreachable. Please try again when the connection is restored."
                ),
            });
            return;
        }
        const message = serverErrorMessage(error);
        if (message) {
            await this.popup.add(ErrorPopup, { title: _t("Cannot Create Quotation"), body: message });
            return;
        }
        throw error;
    }
}

ProductScreen.addControlButton({
    component: PQSCreateQuotationButton,
    condition: function () {
        return this.pos.config.pqs_quotation_enabled;
    },
});
