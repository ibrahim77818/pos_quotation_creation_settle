odoo.define('pos_quotation_creation_settle.models', function (require) {
    'use strict';

    const { Order, Orderline } = require('point_of_sale.models');
    const Registries = require('point_of_sale.Registries');

    const PQSOrder = (Order) => class PQSOrder extends Order {
        constructor() {
            super(...arguments);
            // Receipt data of the quotation created from this cart (if any).
            this.pqs_quotation = this.pqs_quotation || false;
            // Server verdicts of the quotations settled in this cart, keyed by
            // sale.order id: {name, mode, expiry (UTC), prices {sol id: price}}.
            this.pqs_settlement_checks = this.pqs_settlement_checks || {};
        }
        init_from_JSON(json) {
            super.init_from_JSON(...arguments);
            this.pqs_quotation = json.pqs_quotation || false;
            this.pqs_settlement_checks = json.pqs_settlement_checks || {};
        }
        export_as_JSON() {
            const json = super.export_as_JSON(...arguments);
            json.pqs_quotation = this.pqs_quotation || false;
            json.pqs_settlement_checks = this.pqs_settlement_checks || {};
            return json;
        }
        pqsStoreSettlementCheck(check) {
            if (!check || !check.order_id) {
                return;
            }
            this.pqs_settlement_checks = Object.assign({}, this.pqs_settlement_checks, {
                [check.order_id]: {
                    name: check.name,
                    mode: check.mode,
                    expiry: check.expiry || false,
                    prices: check.prices || {},
                },
            });
        }
        /**
         * Same Block-mode rule as the server, using the verdict stored when
         * the quotation was loaded. Works offline, so a paid order can not be
         * rejected later at synchronisation.
         */
        pqsLocalViolations(rounding, downPaymentProductId, now = new Date()) {
            const issues = [];
            for (const line of this.pqsSettlementLines()) {
                if (line.get_quantity() <= 0) {
                    continue;
                }
                const check = this.pqs_settlement_checks[line.sale_order_origin_id.id];
                if (!check || check.mode !== 'block' || !check.expiry) {
                    continue;
                }
                const expiry = new Date(check.expiry.replace(' ', 'T') + 'Z');
                if (!(now > expiry)) {
                    continue;
                }
                if (!line.sale_order_line_id) {
                    if (downPaymentProductId && line.get_product().id === downPaymentProductId) {
                        issues.push({ type: 'down_payment', order: check.name });
                    }
                    continue;
                }
                const required = check.prices[String(line.sale_order_line_id.id)];
                const tolerance = (rounding || 0.01) / 2;
                if (
                    required === undefined
                    || Math.abs(line.get_unit_price() - required) >= tolerance
                    || line.get_discount() > 0
                ) {
                    issues.push({
                        type: 'price',
                        order: check.name,
                        product: line.get_full_product_name(),
                        required,
                    });
                }
            }
            return issues;
        }
        /** Lines coming from a sale order (Quotation/Order settlement). */
        pqsSettlementLines() {
            return this.get_orderlines().filter((line) => line.sale_order_origin_id);
        }
        pqsSettlementPayload() {
            return this.pqsSettlementLines().map((line) => ({
                product_id: line.get_product().id,
                qty: line.get_quantity(),
                price_unit: line.get_unit_price(),
                discount: line.get_discount(),
                sale_order_origin_id: line.sale_order_origin_id ? line.sale_order_origin_id.id : false,
                sale_order_line_id: line.sale_order_line_id ? line.sale_order_line_id.id : false,
            }));
        }
    };
    Registries.Model.extend(Order, PQSOrder);

    const PQSOrderline = (Orderline) => class PQSOrderline extends Orderline {
        constructor() {
            super(...arguments);
            this.pqs_repriced = this.pqs_repriced || false;
        }
        init_from_JSON(json) {
            super.init_from_JSON(...arguments);
            this.pqs_repriced = json.pqs_repriced || false;
        }
        export_as_JSON() {
            const json = super.export_as_JSON(...arguments);
            json.pqs_repriced = this.pqs_repriced || false;
            return json;
        }
    };
    Registries.Model.extend(Orderline, PQSOrderline);

    return { PQSOrder, PQSOrderline };
});
