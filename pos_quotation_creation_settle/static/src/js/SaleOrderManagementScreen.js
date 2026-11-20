odoo.define('pos_quotation_creation_settle.SaleOrderManagementScreen', function (require) {
    'use strict';

    const SaleOrderManagementScreen = require('pos_sale.SaleOrderManagementScreen');
    const Registries = require('point_of_sale.Registries');
    const { isConnectionError, serverErrorMessage } = require('pos_quotation_creation_settle.utils');

    /**
     * Validity governance on the native "Quotation/Order" settlement flow.
     * The verdict (cancelled, fully settled, expired, mode, current prices)
     * comes from the server; it is stored on the cart so the payment screen
     * can enforce it offline, and the server enforces it again at sync.
     */
    const PQSSaleOrderManagementScreen = (Base) => class PQSSaleOrderManagementScreen extends Base {
        async _onClickSaleOrder(event) {
            const clickedOrder = event && event.detail;
            if (!clickedOrder || !clickedOrder.id) {
                return super._onClickSaleOrder(...arguments);
            }
            let check;
            try {
                check = await this.rpc({
                    model: 'sale.order',
                    method: 'pqs_check_pos_settlement',
                    args: [[clickedOrder.id], this.env.pos.config.id],
                });
            } catch (error) {
                await this._pqsShowRpcError(error);
                return;
            }

            if (check.blocked) {
                await this.showPopup('ErrorPopup', {
                    title: this.env._t('Quotation Cannot Be Settled'),
                    body: check.message,
                });
                return;
            }

            if (check.expired && check.mode === 'block') {
                const { confirmed } = await this.showPopup('ConfirmPopup', {
                    title: this.env._t('Expired Quotation: Original Prices Blocked'),
                    body: `${check.message} ${this.env._t('The quotation lines will be re-priced at the current prices and their discounts removed. Down payments are not available for expired quotations.')}`,
                    confirmText: this.env._t('Settle at Current Prices'),
                    cancelText: this.env._t('Cancel'),
                });
                if (!confirmed) {
                    return;
                }
                const currentOrder = this.env.pos.get_order();
                const before = new Set(currentOrder ? currentOrder.get_orderlines() : []);
                const result = await this._pqsSettleWithoutDownPayment(arguments);
                await this._pqsAfterSettlement(check, before, true);
                return result;
            }

            if (check.expired) {
                // Alert Only
                const { confirmed } = await this.showPopup('ConfirmPopup', {
                    title: this.env._t('Expired Quotation'),
                    body: `${check.message} ${this.env._t('Do you want to continue with the settlement?')}`,
                    confirmText: this.env._t('Continue Settlement'),
                    cancelText: this.env._t('Cancel'),
                });
                if (!confirmed) {
                    return;
                }
            }
            const currentOrder = this.env.pos.get_order();
            const before = new Set(currentOrder ? currentOrder.get_orderlines() : []);
            const result = await super._onClickSaleOrder(...arguments);
            await this._pqsAfterSettlement(check, before, false);
            return result;
        }

        /**
         * Run the native flow but answer its "down payment / settle" choice
         * with "settle": a down payment on an expired quotation in Block mode
         * would be based on the original amount.
         */
        async _pqsSettleWithoutDownPayment(args) {
            const originalShowPopup = this.showPopup;
            this.showPopup = (name, props) => {
                const list = props && props.list;
                if (
                    name === 'SelectionPopup'
                    && Array.isArray(list)
                    && list.some((option) => option.item === true)
                    && list.some((option) => option.item === false)
                ) {
                    return Promise.resolve({ confirmed: true, payload: true });
                }
                return originalShowPopup.call(this, name, props);
            };
            try {
                return await super._onClickSaleOrder(...args);
            } finally {
                delete this.showPopup;
            }
        }

        async _pqsAfterSettlement(check, before, reprice) {
            const pos = this.env.pos;
            const order = pos.get_order();
            if (!order) {
                return;
            }
            const added = order.get_orderlines().filter(
                (line) => !before.has(line)
                    && line.sale_order_origin_id
                    && line.sale_order_origin_id.id === check.order_id
            );
            if (!added.length) {
                return; // the settlement was cancelled in the native flow
            }
            order.pqsStoreSettlementCheck(check);
            if (!reprice) {
                pos.db.save_unpaid_order(order);
                return;
            }
            const downPayment = pos.config.down_payment_product_id;
            const downPaymentId = Array.isArray(downPayment) ? downPayment[0] : downPayment;
            const prices = check.prices || {};
            let repriced = 0;
            let removedDownPayment = false;
            for (const line of added) {
                if (!line.sale_order_line_id) {
                    if (downPaymentId && line.get_product().id === downPaymentId) {
                        order.remove_orderline(line);
                        removedDownPayment = true;
                    }
                    continue;
                }
                const price = prices[String(line.sale_order_line_id.id)];
                if (price === undefined) {
                    continue; // the payment screen will refuse it
                }
                // Server price (quotation pricelist, today's product prices):
                // keep it fixed so a quantity change does not re-price it
                // from the prices loaded at session start.
                line.set_discount(0);
                line.set_unit_price(price);
                line.price_manually_set = true;
                line.pqs_repriced = true;
                repriced += 1;
            }
            pos.db.save_unpaid_order(order);
            try {
                if (removedDownPayment) {
                    await this.showPopup('ErrorPopup', {
                        title: this.env._t('Down Payment Not Allowed'),
                        body: this.env._t('Down payments are not available for expired quotations in Block mode. The down-payment line was removed.'),
                    });
                } else if (repriced) {
                    this.showNotification(
                        this.env._t('Expired quotation: lines were re-priced at the current prices.'),
                        4000
                    );
                }
            } catch (_e) {
                // The screen may already be closed; the cart is updated anyway.
            }
        }

        async _pqsShowRpcError(error) {
            if (isConnectionError(error)) {
                await this.showPopup('ErrorPopup', {
                    title: this.env._t('Network Error'),
                    body: this.env._t('The quotation validity could not be checked because the server is unreachable.'),
                });
                return;
            }
            const message = serverErrorMessage(error);
            if (message) {
                await this.showPopup('ErrorPopup', {
                    title: this.env._t('Quotation Cannot Be Settled'),
                    body: message,
                });
                return;
            }
            throw error;
        }
    };

    Registries.Component.extend(SaleOrderManagementScreen, PQSSaleOrderManagementScreen);

    return PQSSaleOrderManagementScreen;
});
