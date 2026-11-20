odoo.define('pos_quotation_creation_settle.CreateQuotationButton', function (require) {
    'use strict';

    const PosComponent = require('point_of_sale.PosComponent');
    const ProductScreen = require('point_of_sale.ProductScreen');
    const Registries = require('point_of_sale.Registries');
    const { isConnectionError, serverErrorMessage, sprintf } = require('pos_quotation_creation_settle.utils');

    class PQSCreateQuotationButton extends PosComponent {
        setup() {
            super.setup();
            this._busy = false;
        }

        async onClick() {
            if (this._busy) {
                return;
            }
            const order = this.env.pos.get_order();
            if (!order) {
                return;
            }
            // The cart was already turned into a quotation: show it again
            // instead of creating a duplicate.
            if (order.pqs_quotation) {
                this.showScreen('PQSQuotationReceiptScreen', { quotation: order.pqs_quotation });
                return;
            }
            if (!(await this._checkCart(order))) {
                return;
            }
            const partner = await this._ensurePartner(order);
            if (!partner) {
                return;
            }
            const { confirmed } = await this.showPopup('ConfirmPopup', {
                title: this.env._t('Create Quotation'),
                body: sprintf(
                    this.env._t('Create a quotation for %s? No payment will be recorded and the cart will be closed.'),
                    partner.name
                ),
                confirmText: this.env._t('Create Quotation'),
                cancelText: this.env._t('Cancel'),
            });
            if (!confirmed) {
                return;
            }
            this._busy = true;
            try {
                const result = await this.rpc({
                    model: 'sale.order',
                    method: 'pqs_create_quotation_from_pos',
                    args: [this._buildPayload(order, partner)],
                });
                order.pqs_quotation = Object.assign({}, result, { pqs_auto_done: false });
                this.env.pos.db.save_unpaid_order(order);
                if (result.salesperson_fallback) {
                    this.showNotification(
                        sprintf(
                            this.env._t('The cashier has no linked user: %s was set as salesperson.'),
                            result.salesperson
                        ),
                        5000
                    );
                }
                this.showScreen('PQSQuotationReceiptScreen', { quotation: order.pqs_quotation });
            } catch (error) {
                await this._handleError(error);
            } finally {
                this._busy = false;
            }
        }

        async _checkCart(order) {
            const lines = order.get_orderlines();
            let body = '';
            if (!lines.length) {
                body = this.env._t('The cart is empty. Add products before creating a quotation.');
            } else if (lines.some((line) => line.sale_order_origin_id)) {
                body = this.env._t('This cart contains lines loaded from an existing quotation or sales order. Settle it with a payment, or start a new cart to create a quotation.');
            } else if (lines.some((line) => line.refunded_orderline_id || line.get_quantity() <= 0)) {
                body = this.env._t('Quotations cannot contain refund or zero-quantity lines.');
            } else if (lines.some((line) => line.get_unit_price() < 0 || line.get_discount() > 100)) {
                body = this.env._t('Quotations cannot contain negative prices or discounts above 100%. Remove reward or discount lines first.');
            } else if (order.get_paymentlines().length) {
                body = this.env._t('Remove the payment lines before creating a quotation.');
            }
            if (body) {
                await this.showPopup('ErrorPopup', {
                    title: this.env._t('Cannot Create Quotation'),
                    body,
                });
                return false;
            }
            return true;
        }

        async _ensurePartner(order) {
            const partner = order.get_partner();
            if (partner) {
                return partner;
            }
            const { confirmed } = await this.showPopup('ConfirmPopup', {
                title: this.env._t('Customer Required'),
                body: this.env._t('A quotation needs a customer. Do you want to select one now?'),
                confirmText: this.env._t('Select Customer'),
                cancelText: this.env._t('Cancel'),
            });
            if (!confirmed) {
                return false;
            }
            const { confirmed: picked, payload: newPartner } = await this.showTempScreen(
                'PartnerListScreen',
                { partner: null }
            );
            if (!picked || !newPartner) {
                return false;
            }
            order.set_partner(newPartner);
            return newPartner;
        }

        _buildPayload(order, partner) {
            const pos = this.env.pos;
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
                    customer_note: line.get_customer_note ? line.get_customer_note() || '' : '',
                })),
            };
        }

        async _handleError(error) {
            if (isConnectionError(error)) {
                await this.showPopup('ErrorPopup', {
                    title: this.env._t('Network Error'),
                    body: this.env._t('The quotation could not be created because the server is unreachable. Please try again when the connection is restored.'),
                });
                return;
            }
            const message = serverErrorMessage(error);
            if (message) {
                await this.showPopup('ErrorPopup', {
                    title: this.env._t('Cannot Create Quotation'),
                    body: message,
                });
                return;
            }
            throw error;
        }
    }
    PQSCreateQuotationButton.template = 'PQSCreateQuotationButton';

    ProductScreen.addControlButton({
        component: PQSCreateQuotationButton,
        condition: function () {
            return this.env.pos.config.pqs_quotation_enabled;
        },
    });

    Registries.Component.add(PQSCreateQuotationButton);

    return PQSCreateQuotationButton;
});
