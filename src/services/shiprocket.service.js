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

async function assignShiprocketAwb(shipmentId, courierId) {
    const validId = value => {
        if (!['number', 'string'].includes(typeof value)) {
            return NaN;
        }

        const number = Number(value);

        return Number.isSafeInteger(number) && number > 0
            ? number
            : NaN;
    };

    const shipment = validId(shipmentId);
    const courier = validId(courierId);

    if (
        !Number.isFinite(shipment) ||
        !Number.isFinite(courier)
    ) {
        throw new Error(
            'Valid shipment and courier IDs are required'
        );
    }

    try {
        const response = await shiprocketRequest(
            'POST',
            '/courier/assign/awb',
            {
                data: {
                    shipment_id: shipment,
                    courier_id: courier,
                },
            }
        );

        console.log('SHIPROCKET AWB RESULT:', {
    awbAssignStatus: response?.awb_assign_status,
    responseStatus: response?.response?.status,
    message:
        response?.response?.message ??
        response?.message ??
        null,
    hasAwb: Boolean(response?.response?.data?.awb_code),
    returnedShipmentId:
        response?.response?.data?.shipment_id ?? null,
    returnedCourierId:
        response?.response?.data?.courier_company_id ?? null,
    error: response?.response?.error ?? null,
});

        const data = response?.response?.data;

        // Keep AWB as a string to preserve leading zeros.
        const awbCode = typeof data?.awb_code === 'string'
            ? data.awb_code.trim()
            : '';

        const returnedShipmentId = validId(
            data?.shipment_id
        );

        const assignedCourierId = validId(
            data?.courier_company_id
        );

        if (
            Number(response?.awb_assign_status) !== 1 ||
            !awbCode ||
            returnedShipmentId !== shipment ||
            !Number.isFinite(assignedCourierId)
        ) {
            throw new Error(
                'Shiprocket did not confirm a valid AWB assignment'
            );
        }

        return {
            shipmentId: returnedShipmentId,
            awbCode,
            courierId: assignedCourierId,
            courierName:
                typeof data.courier_name === 'string'
                    ? data.courier_name.trim()
                    : '',
        };
    } catch (error) {
        // Verify the remote shipment before attempting again.
        error.requiresReview = true;
        throw error;
    }
}

async function requestShiprocketPickup(shipmentId) {
    if (!['number', 'string'].includes(typeof shipmentId)) {
        throw new Error('A valid shipment ID is required');
    }

    const id = Number(shipmentId);

    if (!Number.isSafeInteger(id) || id < 1) {
        throw new Error('A valid shipment ID is required');
    }

    try {
        const response = await shiprocketRequest(
            'POST',
            '/courier/generate/pickup',
            {
                data: {
                    shipment_id: [id],
                },
            }
        );

        if (Number(response?.pickup_status) !== 1) {
            throw new Error(
                'Shiprocket did not confirm the pickup request'
            );
        }

        const scheduledDate =
            response?.response?.pickup_scheduled_date;

        return {
            shipmentId: id,
            pickupRequested: true,
            pickupScheduledDate:
                typeof scheduledDate === 'string'
                    ? scheduledDate.trim() || null
                    : null,
        };
    } catch (error) {
        // A timeout may occur after Shiprocket accepted pickup.
        error.requiresReview = true;
        throw error;
    }
}

async function generateShiprocketDocument(shipmentId, type) {
    if (!['label', 'manifest'].includes(type)) {
        throw new Error('Invalid shipping document type');
    }

    const id = Number(shipmentId);

    if (
        !['number', 'string'].includes(typeof shipmentId) ||
        !Number.isSafeInteger(id) ||
        id < 1
    ) {
        throw new Error('A valid shipment ID is required');
    }

    const config = type === 'label'
        ? {
            endpoint: '/courier/generate/label',
            statusKey: 'label_created',
            urlKey: 'label_url',
        }
        : {
            endpoint: '/manifests/generate',
            statusKey: 'status',
            urlKey: 'manifest_url',
        };

    const response = await shiprocketRequest(
        'POST',
        config.endpoint,
        {
            data: {
                shipment_id: [id],
            },
        }
    );

    if (
        Number(response?.[config.statusKey]) !== 1 ||
        (
            type === 'label' &&
            Array.isArray(response?.not_created) &&
            response.not_created.length > 0
        )
    ) {
        throw new Error(
            `Shiprocket did not confirm ${type} generation`
        );
    }

    const rawUrl = response?.[config.urlKey];
    let url;

    try {
        if (
            typeof rawUrl !== 'string' ||
            !rawUrl.trim()
        ) {
            throw new Error();
        }

        url = new URL(rawUrl.trim());

        if (
            url.protocol !== 'https:' ||
            url.username ||
            url.password
        ) {
            throw new Error();
        }
    } catch {
        throw new Error(
            `Shiprocket returned an invalid ${type} URL`
        );
    }

    return {
        shipmentId: id,
        url: url.href,
    };
}

const generateShiprocketLabel = shipmentId =>
    generateShiprocketDocument(shipmentId, 'label');

const generateShiprocketManifest = shipmentId =>
    generateShiprocketDocument(shipmentId, 'manifest');

async function fetchShiprocketTracking(awbCode) {
    if (typeof awbCode !== 'string') {
        throw new Error('A valid AWB code is required');
    }

    const awb = awbCode.trim();

    if (!/^[a-z0-9-]{1,100}$/i.test(awb)) {
        throw new Error('A valid AWB code is required');
    }

    const response = await shiprocketRequest(
        'GET',
        `/courier/track/awb/${encodeURIComponent(awb)}`
    );

    const trackingData = response?.tracking_data;

    if (
        !trackingData ||
        typeof trackingData !== 'object' ||
        Array.isArray(trackingData) ||
        ![0, 1, '0', '1'].includes(trackingData.track_status)
    ) {
        throw new Error(
            'Unexpected Shiprocket tracking response'
        );
    }

    const trackingAvailable =
        Number(trackingData.track_status) === 1;

    if (trackingAvailable) {
        const shipments = trackingData.shipment_track;

        const matchesAwb =
            Array.isArray(shipments) &&
            shipments.some(
                item =>
                    typeof item?.awb_code === 'string' &&
                    item.awb_code.trim() === awb
            );

        if (!matchesAwb) {
            throw new Error(
                'Tracking response does not match the requested AWB'
            );
        }
    }

    return {
        awbCode: awb,
        trackingAvailable,
        trackingData,
    };
}

module.exports = {
    shiprocketRequest, createShiprocketOrder, assignShiprocketAwb, requestShiprocketPickup, generateShiprocketLabel,
    generateShiprocketManifest, fetchShiprocketTracking
};