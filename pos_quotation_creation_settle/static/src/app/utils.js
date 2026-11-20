/** @odoo-module */

import {
    ConnectionAbortedError,
    ConnectionLostError,
    RPCError,
} from "@web/core/network/rpc_service";

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

/** Down payment product id of the POS (many2one array or id). */
export function downPaymentProductId(config) {
    const value = config.down_payment_product_id;
    return Array.isArray(value) ? value[0] : value || false;
}
