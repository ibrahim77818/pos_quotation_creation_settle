odoo.define('pos_quotation_creation_settle.utils', function (require) {
    'use strict';

    /**
     * True when the RPC failed because the server could not be reached
     * (as opposed to a business error raised by the server).
     */
    function isConnectionError(error) {
        if (!error) {
            return false;
        }
        const message = error.message;
        if (message && typeof message === 'object' && message.code === -32098) {
            return true;
        }
        const name = (error.constructor && error.constructor.name) || error.name || '';
        return ['ConnectionLostError', 'ConnectionAbortedError'].includes(name);
    }

    /** Extract the message of a UserError / ValidationError raised server-side. */
    function serverErrorMessage(error) {
        const message = error && error.message;
        if (message && typeof message === 'object' && message.data && message.data.message) {
            return message.data.message;
        }
        if (error && error.data && error.data.message) {
            return error.data.message;
        }
        return '';
    }

    /** Minimal %s substitution that keeps translated strings intact. */
    function sprintf(str, ...args) {
        let index = 0;
        return String(str).replace(/%s/g, () => (index < args.length ? String(args[index++]) : ''));
    }

    return { isConnectionError, serverErrorMessage, sprintf };
});
