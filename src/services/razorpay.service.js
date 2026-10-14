const Razorpay = require('razorpay');
const crypto = require('crypto');

const paymentError = (message, statusCode = 502) =>
    Object.assign(new Error(message), { statusCode });

function readCredentials() {
    const keyId = process.env.RAZORPAY_KEY_ID?.trim();
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    const mode = process.env.RAZORPAY_MODE?.trim();

    if (
        !keyId ||
        !keySecret ||
        !['Test', 'Live'].includes(mode)
    ) {
        throw paymentError(
            'Razorpay configuration is incomplete',
            503
        );
    }

    const expectedPrefix =
        mode === 'Test' ? 'rzp_test_' : 'rzp_live_';

    if (!keyId.startsWith(expectedPrefix)) {
        throw paymentError(
            'Razorpay key does not match the configured mode',
            503
        );
    }

    return { keyId, keySecret, mode };
}

// Only public configuration can be returned to the frontend.
function getRazorpayConfig() {
    const { keyId, mode } = readCredentials();

    return { keyId, mode };
}

function getClient() {
    const { keyId, keySecret } = readCredentials();

    return new Razorpay({
        key_id: keyId,
        key_secret: keySecret,
    });
}

async function createRazorpayOrder({
    checkoutId,
    amountPaise,
}) {
    if (
        typeof checkoutId !== 'string' ||
        !/^[a-f\d]{24}$/i.test(checkoutId)
    ) {
        throw paymentError('Invalid checkout ID', 400);
    }

    if (
        !Number.isSafeInteger(amountPaise) ||
        amountPaise < 100
    ) {
        throw paymentError(
            'Payment amount must be at least 100 paise',
            400
        );
    }

    const client = getClient();
    const receipt = checkoutId.toLowerCase();

    try {
        const order = await client.orders.create({
            amount: amountPaise,
            currency: 'INR',
            receipt,
            partial_payment: false,
            notes: {
                checkoutId: receipt,
            },
        });

        if (
            typeof order?.id !== 'string' ||
            !/^order_[a-z\d]+$/i.test(order.id) ||
            order.entity !== 'order' ||
            order.amount !== amountPaise ||
            order.currency !== 'INR' ||
            order.receipt !== receipt
        ) {
            throw new Error(
                'Unexpected Razorpay order response'
            );
        }

        return {
            id: order.id,
            amount: order.amount,
            currency: order.currency,
            receipt: order.receipt,
        };
    } catch {
        // Creation may have succeeded before a connection failed.
        // Do not automatically create another Razorpay order.
        const error = paymentError(
            'Unable to confirm Razorpay order creation. ' +
            'Check the saved checkout before retrying.'
        );

        error.requiresReview = true;

        throw error;
    }
}

// Used to verify provider details during payment reconciliation.
async function fetchRazorpayOrder(razorpayOrderId) {
    if (
        typeof razorpayOrderId !== 'string' ||
        !/^order_[a-z\d]+$/i.test(razorpayOrderId)
    ) {
        throw paymentError(
            'Invalid Razorpay order ID',
            400
        );
    }

    const client = getClient();

    try {
        const order = await client.orders.fetch(
            razorpayOrderId
        );

        if (
            order?.entity !== 'order' ||
            order.id !== razorpayOrderId
        ) {
            throw new Error(
                'Unexpected Razorpay order response'
            );
        }

        return order;
    } catch {
        throw paymentError(
            'Unable to verify the Razorpay order'
        );
    }
}

function verifyRazorpayWebhook(rawBody, signature) {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

    if (!secret) {
        throw paymentError(
            'Razorpay webhook secret is missing',
            503
        );
    }

    if (!Buffer.isBuffer(rawBody)) {
        throw paymentError(
            'Razorpay webhook requires the raw request body',
            500
        );
    }

    if (
        typeof signature !== 'string' ||
        !/^[a-f\d]{64}$/i.test(signature)
    ) {
        return false;
    }

    const expected = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest();

    const received = Buffer.from(signature, 'hex');

    return crypto.timingSafeEqual(expected, received);
}

async function fetchRazorpayPayment(paymentId) {
    if (
        typeof paymentId !== 'string' ||
        !/^pay_[a-z\d]+$/i.test(paymentId)
    ) {
        throw paymentError(
            'Invalid Razorpay payment ID',
            400
        );
    }

    const client = getClient();

    try {
        const payment = await client.payments.fetch(paymentId);

        if (
            payment?.entity !== 'payment' ||
            payment.id !== paymentId
        ) {
            throw new Error(
                'Unexpected Razorpay payment response'
            );
        }

        return payment;
    } catch {
        throw paymentError(
            'Unable to verify the Razorpay payment'
        );
    }
}

module.exports = {
    getRazorpayConfig,
    createRazorpayOrder,
    fetchRazorpayOrder,
    verifyRazorpayWebhook,
    fetchRazorpayPayment
};