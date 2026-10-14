const axios = require('axios');

const client = axios.create({
    baseURL: 'https://apiv2.shiprocket.in/v1/external',
    timeout: 20000,
    maxRedirects: 0,
    headers: {
        'Content-Type': 'application/json',
    },
});

let cachedToken = null;
let tokenExpiresAt = 0;
let loginPromise = null;

async function getToken() {
    if (cachedToken && Date.now() < tokenExpiresAt) {
        return cachedToken;
    }

    if (!loginPromise) {
        loginPromise = (async () => {
            const email = process.env.SHIPROCKET_EMAIL;
            const password = process.env.SHIPROCKET_PASSWORD;

            if (!email || !password) {
                throw new Error('Shiprocket credentials are missing');
            }

            let data;

            try {
                const response = await client.post('/auth/login', {
                    email,
                    password,
                });

                data = response.data;
            } catch {
                throw new Error(
                    'Shiprocket authentication failed. Check API credentials.'
                );
            }

            if (typeof data?.token !== 'string' || !data.token) {
                throw new Error('Shiprocket returned an invalid token');
            }

            cachedToken = data.token;

            // Refresh before the documented 10-day expiry.
            tokenExpiresAt = Date.now() + 9 * 24 * 60 * 60 * 1000;

            return cachedToken;
        })().finally(() => {
            loginPromise = null;
        });
    }

    return loginPromise;
}

async function shiprocketRequest(
    method,
    endpoint,
    { data, params } = {}
) {
    const token = await getToken();

    try {
        const response = await client.request({
            method,
            url: endpoint,
            data,
            params,
            headers: {
                Authorization: `Bearer ${token}`,
            },
        });

        return response.data;
    } catch (error) {
        const providerStatus = error.response?.status;

        if (providerStatus === 401 && cachedToken === token) {
            cachedToken = null;
            tokenExpiresAt = 0;
        }

        // Avoid exposing Axios config containing credentials or tokens.
        const safeError = new Error(
            providerStatus
                ? `Shiprocket request failed (HTTP ${providerStatus})`
                : 'Unable to contact Shiprocket'
        );

        safeError.providerStatus = providerStatus;
        throw safeError;
    }
}

async function createShiprocketOrder(payload) {
    if (
        !payload ||
        typeof payload.order_id !== 'string' ||
        !payload.order_id.trim()
    ) {
        throw new Error('A source order ID is required');
    }

    if (payload?.payment_method !== 'Prepaid') {
        throw new Error('Only prepaid shipments are supported');
    }

    let response;

    try {
        response = await shiprocketRequest(
            'POST',
            '/orders/create/adhoc',
            { data: payload }
        );
    } catch (error) {
        // The request may have succeeded before a timeout.
        // The controller must check Shiprocket before retrying.
        error.requiresReview = true;
        throw error;
    }

    const shiprocketOrderId = Number(response?.order_id);
    const shipmentId = Number(response?.shipment_id);

    if (
        !Number.isSafeInteger(shiprocketOrderId) ||
        shiprocketOrderId < 1 ||
        !Number.isSafeInteger(shipmentId) ||
        shipmentId < 1
    ) {
        const error = new Error(
            'Shiprocket did not return valid order and shipment IDs'
        );

        error.requiresReview = true;
        throw error;
    }

    return {
        sourceOrderId: payload.order_id,
        shiprocketOrderId,
        shipmentId,
        shipmentStatus: response.status || 'NEW',
    };
}

module.exports = { shiprocketRequest, createShiprocketOrder };