/** @odoo-module */

import { _t } from "@web/core/l10n/translation";
import { patch } from "@web/core/utils/patch";
import { SaleOrderManagementScreen } from "@pos_sale/app/order_management_screen/sale_order_management_screen/sale_order_management_screen";
import { SelectionPopup } from "@point_of_sale/app/utils/input_popups/selection_popup";
import { ErrorPopup } from "@point_of_sale/app/errors/popups/error_popup";
import { ConfirmPopup } from "@point_of_sale/app/utils/confirm_popup/confirm_popup";
import {
    downPaymentProductId,
    isConnectionError,
    serverErrorMessage,
} from "@pos_quotation_creation_settle/app/utils";

/**
 * Validity governance on the native "Quotation/Order" settlement flow.
 * The verdict (cancelled, fully settled, expired, mode, current prices)
 * comes from the server; it is stored on the cart so the payment screen can
 * enforce it offline, and the server enforces it again at sync.
 */
patch(SaleOrderManagementScreen.prototype, {
    async onClickSaleOrder(clickedOrder) {
        if (!clickedOrder || !clickedOrder.id) {
            return super.onClickSaleOrder(...arguments);
        }
        let check;
        try {
            check = await this.orm.call("sale.order", "pqs_check_pos_settlement", [
                [clickedOrder.id],
                this.pos.config.id,
            ]);
        } catch (error) {
            await this._pqsShowRpcError(error);
            return;
        }

        if (check.blocked) {
            await this.popup.add(ErrorPopup, {
                title: _t("Quotation Cannot Be Settled"),
                body: check.message,
            });
            return;
        }

        if (check.expired && check.mode === "block") {
            const { confirmed } = await this.popup.add(ConfirmPopup, {
                title: _t("Expired Quotation: Original Prices Blocked"),
                body: `${check.message} ${_t(
                    "The quotation lines will be re-priced at the current prices and their discounts removed. Down payments are not available for expired quotations."
                )}`,
                confirmText: _t("Settle at Current Prices"),
                cancelText: _t("Cancel"),
            });
            if (!confirmed) {
                return;
            }
            const before = new Set(this.pos.get_order()?.get_orderlines() || []);
            const result = await this._pqsSettleWithoutDownPayment(clickedOrder);
            await this._pqsAfterSettlement(check, before, true);
            return result;
        }

        if (check.expired) {
            // Alert Only
            const { confirmed } = await this.popup.add(ConfirmPopup, {
                title: _t("Expired Quotation"),
                body: `${check.message} ${_t("Do you want to continue with the settlement?")}`,
                confirmText: _t("Continue Settlement"),
                cancelText: _t("Cancel"),
            });
            if (!confirmed) {
                return;
            }
        }
        const before = new Set(this.pos.get_order()?.get_orderlines() || []);
        const result = await super.onClickSaleOrder(...arguments);
        await this._pqsAfterSettlement(check, before, false);
        return result;
    },

    /**
     * Run the native flow but answer its "settle / down payment" choice with
     * "settle": a down payment on an expired quotation in Block mode would be
     * based on the original amount.
     */
    async _pqsSettleWithoutDownPayment(clickedOrder) {
        const popup = this.popup;
        this.popup = Object.assign(Object.create(popup), {
            add: (component, props) => {
                if (
                    component === SelectionPopup &&
                    (props?.list || []).some((option) => option.item === "settle")
                ) {
                    return Promise.resolve({ confirmed: true, payload: "settle" });
                }
                return popup.add(component, props);
            },
        });
        try {
            return await super.onClickSaleOrder(clickedOrder);
        } finally {
            this.popup = popup;
        }
    },

    async _pqsAfterSettlement(check, before, reprice) {
        const order = this.pos.get_order();
        if (!order) {
            return;
        }
        const added = order
            .get_orderlines()
            .filter(
                (line) =>
                    !before.has(line) &&
                    line.sale_order_origin_id &&
                    line.sale_order_origin_id.id === check.order_id
            );
        if (!added.length) {
            return; // the settlement was cancelled in the native flow
        }
        order.pqsStoreSettlementCheck(check);
        if (!reprice) {
            return;
        }
        const dpId = downPaymentProductId(this.pos.config);
        const prices = check.prices || {};
        let repriced = 0;
        let removedDownPayment = false;
        for (const line of added) {
            if (!line.sale_order_line_id) {
                if (dpId && line.get_product().id === dpId) {
                    order.removeOrderline(line);
                    removedDownPayment = true;
                }
                continue;
            }
            const price = prices[String(line.sale_order_line_id.id)];
            if (price === undefined) {
                continue; // the payment screen will refuse it
            }
            // Server price (quotation pricelist, today's product prices),
            // kept fixed so a quantity change does not re-price it.
            line.set_discount(0);
            line.set_unit_price(price);
            line.price_type = "manual";
            line.pqs_repriced = true;
            repriced += 1;
        }
        if (removedDownPayment) {
            await this.popup.add(ErrorPopup, {
                title: _t("Down Payment Not Allowed"),
                body: _t(
                    "Down payments are not available for expired quotations in Block mode. The down-payment line was removed."
                ),
            });
        } else if (repriced) {
            this.notification.add(
                _t("Expired quotation: lines were re-priced at the current prices."),
                4000
            );
        }
    },

    async _pqsShowRpcError(error) {
        if (isConnectionError(error)) {
            await this.popup.add(ErrorPopup, {
                title: _t("Network Error"),
                body: _t(
                    "The quotation validity could not be checked because the server is unreachable."
                ),
            });
            return;
        }
        const message = serverErrorMessage(error);
        if (message) {
            await this.popup.add(ErrorPopup, {
                title: _t("Quotation Cannot Be Settled"),
                body: message,
            });
            return;
        }
        throw error;
    },
});
