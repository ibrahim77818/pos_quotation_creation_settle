odoo.define('pos_quotation_creation_settle.PaymentScreen', function (require) {
    'use strict';

    const PaymentScreen = require('point_of_sale.PaymentScreen');
    const Registries = require('point_of_sale.Registries');
    const { isConnectionError, sprintf } = require('pos_quotation_creation_settle.utils');

    const PQSPaymentScreen = (Base) => class PQSPaymentScreen extends Base {
        async _isOrderValid(isForceValidate) {
            const order = this.currentOrder;
            if (order && order.pqs_quotation) {
                await this.showPopup('ErrorPopup', {
                    title: this.env._t('Quotation Already Created'),
                    body: sprintf(
                        this.env._t('This cart was already converted into quotation %s. Start a new order, or settle the quotation through Quotation/Order.'),
                        order.pqs_quotation.name
                    ),
                });
                return false;
            }
            const valid = await super._isOrderValid(...arguments);
            if (!valid || !order || !order.pqsSettlementLines().length) {
                return valid;
            }
            // 1. Local check with the verdict stored at load: works offline,
            //    so the payment is refused before cash is taken.
            const localMessages = this._pqsLocalMessages(order);
            if (localMessages.length) {
                await this.showPopup('ErrorPopup', {
                    title: this.env._t('Settlement Not Allowed'),
                    body: localMessages.join(' '),
                });
                return false;
            }
            // 2. Server verdict (current prices, already settled, cancelled,
            //    optional stock check).
            try {
                const result = await this.rpc({
                    model: 'pos.order',
                    method: 'pqs_validate_settlement',
                    args: [
                        this.env.pos.config.id,
                        order.pricelist ? order.pricelist.id : false,
                        order.pqsSettlementPayload(),
                    ],
                });
                if (result && !result.ok) {
                    await this.showPopup('ErrorPopup', {
                        title: this.env._t('Settlement Not Allowed'),
                        body: result.messages.join(' '),
                    });
                    return false;
                }
            } catch (error) {
                if (isConnectionError(error)) {
                    // Offline: the local check above already passed; the
                    // server enforces the same rules when the order syncs.
                    return true;
                }
                throw error;
            }
            return true;
        }

        _pqsLocalMessages(order) {
            const pos = this.env.pos;
            const downPayment = pos.config.down_payment_product_id;
            const downPaymentId = Array.isArray(downPayment) ? downPayment[0] : downPayment;
            const issues = order.pqsLocalViolations(pos.currency && pos.currency.rounding, downPaymentId);
            return issues.map((issue) => {
                if (issue.type === 'down_payment') {
                    return sprintf(
                        this.env._t('Quotation %s has expired: a down payment based on its original amount is not allowed.'),
                        issue.order
                    );
                }
                if (issue.required === undefined) {
                    return sprintf(
                        this.env._t('Quotation %s has expired: the current price of "%s" is unknown. Load the quotation again.'),
                        issue.order,
                        issue.product
                    );
                }
                return sprintf(
                    this.env._t('Quotation %s has expired: "%s" must be settled at the current price %s without discount.'),
                    issue.order,
                    issue.product,
                    pos.format_currency(issue.required)
                );
            });
        }
    };

    Registries.Component.extend(PaymentScreen, PQSPaymentScreen);

    return PQSPaymentScreen;
});
