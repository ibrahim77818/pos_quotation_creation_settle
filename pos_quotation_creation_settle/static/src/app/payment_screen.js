/** @odoo-module */

import { _t } from "@web/core/l10n/translation";
import { patch } from "@web/core/utils/patch";
import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { ErrorPopup } from "@point_of_sale/app/errors/popups/error_popup";
import { downPaymentProductId, isConnectionError } from "@pos_quotation_creation_settle/app/utils";

patch(PaymentScreen.prototype, {
    async _isOrderValid(isForceValidate) {
        const order = this.currentOrder;
        if (order && order.pqs_quotation) {
            await this.popup.add(ErrorPopup, {
                title: _t("Quotation Already Created"),
                body: _t(
                    "This cart was already converted into quotation %s. Start a new order, or settle the quotation through Quotation/Order.",
                    order.pqs_quotation.name
                ),
            });
            return false;
        }
        const valid = await super._isOrderValid(...arguments);
        if (!valid || !order || !order.pqsSettlementLines().length) {
            return valid;
        }
        // 1. Local check with the verdict stored at load: works offline, so
        //    the payment is refused before cash is taken.
        const localMessages = this._pqsLocalMessages(order);
        if (localMessages.length) {
            await this.popup.add(ErrorPopup, {
                title: _t("Settlement Not Allowed"),
                body: localMessages.join(" "),
            });
            return false;
        }
        // 2. Server verdict (current prices, already settled, cancelled,
        //    optional stock check).
        try {
            const result = await this.orm.call("pos.order", "pqs_validate_settlement", [
                this.pos.config.id,
                order.pricelist ? order.pricelist.id : false,
                order.pqsSettlementPayload(),
            ]);
            if (result && !result.ok) {
                await this.popup.add(ErrorPopup, {
                    title: _t("Settlement Not Allowed"),
                    body: result.messages.join(" "),
                });
                return false;
            }
        } catch (error) {
            if (isConnectionError(error)) {
                // Offline. Price rules were checked locally above and are
                // enforced again at sync, but stock cannot be checked without
                // the server and is not re-checked at sync: refuse the
                // payment rather than let an out-of-stock settlement through.
                if (this.pos.config.pqs_check_stock_before_settle) {
                    await this.popup.add(ErrorPopup, {
                        title: _t("Settlement Not Allowed"),
                        body: _t(
                            "The stock could not be checked because the server is unreachable. Settle this quotation when the connection is restored."
                        ),
                    });
                    return false;
                }
                return true;
            }
            throw error;
        }
        return true;
    },

    _pqsLocalMessages(order) {
        const issues = order.pqsLocalViolations(
            this.pos.currency && this.pos.currency.rounding,
            downPaymentProductId(this.pos.config)
        );
        return issues.map((issue) => {
            if (issue.type === "down_payment") {
                return _t(
                    "Quotation %s has expired: a down payment based on its original amount is not allowed.",
                    issue.order
                );
            }
            if (issue.required === undefined) {
                return _t(
                    'Quotation %s has expired: the current price of "%s" is unknown. Load the quotation again.',
                    issue.order,
                    issue.product
                );
            }
            return _t(
                'Quotation %s has expired: "%s" must be settled at the current price %s without discount.',
                issue.order,
                issue.product,
                this.env.utils.formatCurrency(issue.required)
            );
        });
    },
});
