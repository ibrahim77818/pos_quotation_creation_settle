import { ConnectionAbortedError, ConnectionLostError, RPCError } from "@web/core/network/rpc";

/** True when the server could not be reached (not a business error). */
export function isConnectionError(error) {
    return error instanceof ConnectionLostError || error instanceof ConnectionAbortedError;
}

/** Message of a UserError / ValidationError raised by the server. */
export function serverErrorMessage(error) {
    if (error instanceof RPCError) {
        return (error.data && error.data.message) || error.message || "";
    }
    return "";
}

/**
 * Same Block-mode rule as the server, using the verdicts stored on the order
 * when quotations were loaded. Works offline, so a paid order cannot be
 * rejected later at synchronisation.
 */
export function localViolations(order, checks, rounding, downPaymentProductId, now = new Date()) {
    const issues = [];
    for (const line of order.getOrderlines()) {
        const origin = line.sale_order_origin_id;
        if (!origin || line.getQuantity() <= 0) {
            continue;
        }
        const check = checks[origin.id];
        if (!check || check.mode !== "block" || !check.expiry) {
            continue;
        }
        const expiry = new Date(check.expiry.replace(" ", "T") + "Z");
        if (!(now > expiry)) {
            continue;
        }
        const sol = line.sale_order_line_id;
        if (!sol) {
            // Positive = a new down payment on the original amount;
            // negative = deduction of an earlier one (allowed).
            if (
                downPaymentProductId &&
                line.product_id.id === downPaymentProductId &&
                line.price_unit > 0
            ) {
                issues.push({ type: "down_payment", order: check.name });
            }
            continue;
        }
        if (sol.is_downpayment) {
            continue;
        }
        const required = check.prices[String(sol.id)];
        const tolerance = (rounding || 0.01) / 2;
        if (
            required === undefined ||
            Math.abs(line.price_unit - required) >= tolerance ||
            line.getDiscount() > 0
        ) {
            issues.push({
                type: "price",
                order: check.name,
                product: line.getFullProductName(),
                required,
            });
        }
    }
    return issues;
}

/** Lines of the order that come from a sale order, as sent to the server. */
export function settlementPayload(order) {
    return order
        .getOrderlines()
        .filter((line) => line.sale_order_origin_id)
        .map((line) => ({
            product_id: line.product_id.id,
            qty: line.getQuantity(),
            price_unit: line.price_unit,
            discount: line.getDiscount(),
            sale_order_origin_id: line.sale_order_origin_id.id,
            sale_order_line_id: line.sale_order_line_id ? line.sale_order_line_id.id : false,
        }));
}
