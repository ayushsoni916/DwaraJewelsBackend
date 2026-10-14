const Order = require('../models/order.model');
const Cart = require('../models/cart.model');
const Product = require('../models/product.model');
const PaymentCheckout = require('../models/paymentCheckout.model');

const {
    getRazorpayConfig,
    fetchRazorpayOrder,
    fetchRazorpayPayment,
    verifyRazorpayWebhook,
} = require('../services/razorpay.service');

const {
    getCartSignature,
} = require('../services/checkoutSnapshot.service');

const webhookError = (message, statusCode = 503) =>
    Object.assign(new Error(message), { statusCode });

const needsReview = message =>
    Object.assign(new Error(message), {
        needsPaymentReview: true,
    });

const pendingStates = [
    'Creating',
    'AwaitingPayment',
    'CreationNeedsReview',
];


const PAYMENT_DEBUG = process.env.NODE_ENV !== 'production';

function paymentLog(stage, details = {}) {
    if (!PAYMENT_DEBUG) return;

    console.log(
        `\n[RAZORPAY] ${new Date().toISOString()} | ${stage}`,
        details
    );
}

function paymentLogError(stage, error) {
    console.error(`[RAZORPAY ERROR] ${stage}`, {
        message: error.message,
        name: error.name,
        code: error.code,
        statusCode: error.statusCode,
        needsPaymentReview: error.needsPaymentReview,
        stack: PAYMENT_DEBUG ? error.stack : undefined,
    });
}


function assertCheckoutBinding(checkout, payment, config) {
    if (
        checkout.mode !== config.mode ||
        checkout.keyId !== config.keyId
    ) {
        throw webhookError(
            'Payment configuration does not match this checkout'
        );
    }

    if (
        (
            checkout.razorpayOrderId &&
            checkout.razorpayOrderId !== payment.order_id
        ) ||
        (
            checkout.razorpayPaymentId &&
            checkout.razorpayPaymentId !== payment.id
        )
    ) {
        throw webhookError('Payment identity mismatch', 409);
    }
}

async function finalizeCheckout(
    checkoutId,
    payment,
    capturedAt,
    config,
    reviewReason = ''
) {
    let result;
    paymentLog('09 - STARTING MONGODB TRANSACTION', {
        checkoutId: String(checkoutId),
        paymentId: payment.id,
    });
    await Order.db.transaction(async session => {
        const checkout = await PaymentCheckout.findById(
            checkoutId
        ).session(session);

        if (!checkout) {
            throw webhookError('Checkout snapshot is missing');
        }

         paymentLog('10 - CHECKOUT LOADED IN TRANSACTION', {
        found: Boolean(checkout),
        status: checkout?.status,
        itemCount: checkout?.items?.length,
        amountPaise: checkout?.amountPaise,
        currency: checkout?.currency,
    });

        assertCheckoutBinding(checkout, payment, config);

        // Duplicate deliveries cannot repeat stock changes.
        if (
            ['OrderPlaced', 'PaidNeedsReview'].includes(
                checkout.status
            )
        ) {
            if (checkout.razorpayPaymentId !== payment.id) {
                throw webhookError(
                    'Stored payment identity is missing',
                    409
                );
            }

            result = { status: checkout.status };
            return;
        }

        if (!pendingStates.includes(checkout.status)) {
            throw webhookError('Unexpected checkout state');
        }

        // This write serializes concurrent deliveries.
        checkout.razorpayOrderId = payment.order_id;
        checkout.razorpayPaymentId = payment.id;
        checkout.paidAt = capturedAt;

        await checkout.save({ session });

        if (reviewReason) {
            checkout.status = 'PaidNeedsReview';
            checkout.lastError = reviewReason;

            await checkout.save({ session });

            result = { status: 'PaidNeedsReview' };
            return;
        }

        if (
            checkout.currency !== 'INR' ||
            checkout.amountPaise !== payment.amount ||
            Math.round(
                checkout.summary?.totalCost * 100
            ) !== payment.amount ||
            !checkout.items.length
        ) {
            throw needsReview(
                'Captured amount does not match a valid checkout snapshot'
            );
        }

        paymentLog('11 - BEGINNING STOCK DEDUCTION', {
            totalItems: checkout.items.length,
        });

        for (const item of checkout.items) {
            if (
                !item.dimensionId ||
                !Number.isSafeInteger(item.quantity) ||
                item.quantity < 1 ||
                !Number.isFinite(item.priceAtPurchase) ||
                item.priceAtPurchase < 0
            ) {
                throw needsReview(
                    'An ordered item needs manual review'
                );
            }

            const updated = await Product.updateOne(
                {
                    _id: item.product,
                    isActive: { $ne: false },
                    dimensions: {
                        $elemMatch: {
                            _id: item.dimensionId,
                            stock: { $gte: item.quantity },
                        },
                    },
                },
                {
                    $inc: {
                        'dimensions.$.stock': -item.quantity,
                    },
                },
                { session }
            );

            paymentLog('12 - STOCK UPDATE RESULT', {
                productId: String(item.product),
                dimensionId: String(item.dimensionId),
                quantity: item.quantity,
                matchedCount: updated.matchedCount,
                modifiedCount: updated.modifiedCount,
            });

            if (updated.modifiedCount !== 1) {
                throw needsReview(
                    'A paid item is unavailable or has insufficient stock'
                );
            }
        }

        const [order] = await Order.create(
            [{
                user: checkout.user,
                items: checkout.items.map(item => ({
                    product: item.product,
                    dimensionId: item.dimensionId,
                    quantity: item.quantity,
                    size: item.size,
                    priceAtPurchase: item.priceAtPurchase,
                })),
                shippingAddress: checkout.shippingAddress,
                summary: {
                    subtotal: checkout.summary.subtotal,
                    discount: checkout.summary.discount,
                    shipping: checkout.summary.shipping,
                    totalCost: checkout.summary.totalCost,
                },
                status: 'Pending',
                paymentType: 'Online',
                paymentStatus:
                    checkout.mode === 'Test'
                        ? 'TestPaid'
                        : 'Paid',
                payment: {
                    provider: 'Razorpay',
                    mode: checkout.mode,
                    razorpayOrderId: payment.order_id,
                    razorpayPaymentId: payment.id,
                    amountPaise: payment.amount,
                    currency: payment.currency,
                    capturedAt,
                },
                orderDate: capturedAt,
            }],
            { session }
        );

        paymentLog('13 - MONGODB ORDER CREATED', {
            orderId: String(order._id),
            checkoutId: String(checkout._id),
            amount: order.summary.totalCost,
            paymentStatus: order.paymentStatus,
        });

        const cart = await Cart.findOne({
            _id: checkout.cartId,
            user: checkout.user,
        }).session(session);

        // Preserve any cart changes made after starting payment.
        if (
            cart &&
            getCartSignature(cart) === checkout.cartSignature
        ) {
            await Cart.deleteOne(
                {
                    _id: cart._id,
                    user: checkout.user,
                },
                { session }
            );
        }

        paymentLog('14 - CART PROCESSING COMPLETED', {
            cartFound: Boolean(cart),
            cartMatchedSnapshot: cart
                ? getCartSignature(cart) === checkout.cartSignature
                : false,
        });

        checkout.status = 'OrderPlaced';
        checkout.order = order._id;
        checkout.lastError = '';

        await checkout.save({ session });

        paymentLog('15 - CHECKOUT MARKED ORDERPLACED', {
            checkoutId: String(checkout._id),
            orderId: String(order._id),
            status: checkout.status,
        });

        result = { status: 'OrderPlaced' };
    });

    paymentLog('16 - TRANSACTION COMMITTED', {
        checkoutId: String(checkoutId),
        result: result?.status,
    });

   
    return result;
}

exports.razorpayWebhook = async (req, res) => {
    res.set('Cache-Control', 'private, no-store');

    try {
        const signature = req.get('x-razorpay-signature');


        paymentLog('01 - WEBHOOK RECEIVED', {
            method: req.method,
            path: req.originalUrl,
            contentType: req.get('content-type'),
            eventId: req.get('x-razorpay-event-id') || null,
            signaturePresent: Boolean(signature),
            rawBodyIsBuffer: Buffer.isBuffer(req.body),
            bodySizeBytes: Buffer.isBuffer(req.body)
                ? req.body.length
                : null,
        });


        // Verify before parsing JSON.
        if (!verifyRazorpayWebhook(req.body, signature)) {
            paymentLog('02 - SIGNATURE REJECTED');
            return res.status(401).json({
                success: false,
                error: 'Invalid webhook signature',
            });
        }
        paymentLog('02 - SIGNATURE VERIFIED');
        let event;

        try {
            event = JSON.parse(req.body.toString('utf8'));
        } catch {
            throw webhookError('Invalid webhook JSON', 400);
        }


        paymentLog('03 - WEBHOOK PARSED', {
            event: event?.event,
            eventCreatedAt: event?.created_at,
            payment: {
                id: event?.payload?.payment?.entity?.id,
                orderId: event?.payload?.payment?.entity?.order_id,
                status: event?.payload?.payment?.entity?.status,
                captured: event?.payload?.payment?.entity?.captured,
                capturedType: typeof event?.payload?.payment?.entity?.captured,
                amount: event?.payload?.payment?.entity?.amount,
                currency: event?.payload?.payment?.entity?.currency,
            },
        });


        if (
            !event ||
            typeof event !== 'object' ||
            Array.isArray(event) ||
            typeof event.event !== 'string'
        ) {
            throw webhookError('Invalid webhook event', 400);
        }

        // Failed or merely authorised payments cannot place orders.
        if (event.event !== 'payment.captured') {
            return res.status(200).json({
                success: true,
                received: true,
                status: 'Ignored',
            });
        }

        const payment = event.payload?.payment?.entity;

        if (
            payment?.entity !== 'payment' ||
            typeof payment.id !== 'string' ||
            !/^pay_[a-z\d]+$/i.test(payment.id) ||
            typeof payment.order_id !== 'string' ||
            !/^order_[a-z\d]+$/i.test(payment.order_id) ||
            payment.status !== 'captured' ||
            payment.captured !== true ||
            !Number.isSafeInteger(payment.amount) ||
            payment.amount < 100 ||
            payment.currency !== 'INR'
        ) {
            throw webhookError(
                'Invalid captured payment payload',
                400
            );
        }

        const config = getRazorpayConfig();

        await PaymentCheckout.init();

        let checkout = await PaymentCheckout.findOne({
            razorpayOrderId: payment.order_id,
        }).lean();


        paymentLog('04 - CHECKOUT LOOKUP', {
            razorpayOrderId: payment.order_id,
            found: Boolean(checkout),
            checkoutId: checkout?._id?.toString(),
            checkoutStatus: checkout?.status,
            savedPaymentId: checkout?.razorpayPaymentId,
        });


        if (!checkout) {
            // Handles capture arriving before createOrder saves the ID.
            const remoteOrder = await fetchRazorpayOrder(
                payment.order_id
            );

            const checkoutId = remoteOrder.notes?.checkoutId;

            if (
                typeof checkoutId !== 'string' ||
                !/^[a-f\d]{24}$/i.test(checkoutId) ||
                remoteOrder.receipt !== checkoutId
            ) {
                return res.status(200).json({
                    success: true,
                    received: true,
                    status: 'UnrelatedPayment',
                });
            }

            checkout = await PaymentCheckout.findById(
                checkoutId
            ).lean();

            if (!checkout) {
                throw webhookError(
                    'Checkout snapshot is missing'
                );
            }
        }

        paymentLog('05 - CHECKING PAYMENT BINDING', {
            checkoutId: checkout?._id?.toString(),
            checkoutMode: checkout?.mode,
            configuredMode: config.mode,
            checkoutAmount: checkout?.amountPaise,
            paymentAmount: payment.amount,
        });

        assertCheckoutBinding(checkout, payment, config);

        paymentLog('05 - PAYMENT BINDING VERIFIED');

        if (
            ['OrderPlaced', 'PaidNeedsReview'].includes(
                checkout.status
            )
        ) {
            if (checkout.razorpayPaymentId !== payment.id) {
                throw webhookError(
                    'Stored payment identity is missing',
                    409
                );
            }

            return res.status(200).json({
                success: true,
                received: true,
                status: checkout.status,
            });
        }


        paymentLog('06 - FETCHING PAYMENT FROM RAZORPAY', {
            paymentId: payment.id,
        });
        // Verify current payment through this mode's API credentials.
        const current = await fetchRazorpayPayment(payment.id);


        paymentLog('06 - RAZORPAY API RESPONSE', {
            id: current.id,
            orderId: current.order_id,
            status: current.status,
            captured: current.captured,
            capturedType: typeof current.captured,
            amount: current.amount,
            currency: current.currency,
            refundedAmount: current.amount_refunded,
            method: current.method,
        });


        if (
            current.order_id !== payment.order_id ||
            current.amount !== payment.amount ||
            current.currency !== payment.currency ||
            !Number.isSafeInteger(current.amount_refunded) ||
            current.amount_refunded < 0
        ) {
            throw webhookError(
                'Unexpected payment verification response'
            );
        }

        const refunded = current.amount_refunded > 0;

        if (
            !refunded &&
            (
                current.status !== 'captured' ||
                current.captured !== true
            )
        ) {
            throw webhookError(
                'Payment capture is not yet confirmed'
            );
        }

        const date = new Date(event.created_at * 1000);

        const capturedAt =
            Number.isSafeInteger(event.created_at) &&
                event.created_at > 0 &&
                Number.isFinite(date.getTime())
                ? date
                : new Date();

        const reviewReason = refunded
            ? 'Payment was refunded before order fulfillment'
            : current.method === 'cod'
                ? 'COD payments are not supported'
                : '';

        let result;

        try {
            paymentLog('07 - STARTING ORDER FINALIZATION', {
                checkoutId: checkout._id.toString(),
                paymentId: payment.id,
                reviewReason,
            });
            result = await finalizeCheckout(
                checkout._id,
                payment,
                capturedAt,
                config,
                reviewReason
            );
        } catch (error) {
            if (!error.needsPaymentReview) {
                paymentLogError('07 - FINALIZATION ATTEMPT FAILED', error);
                throw error;
            }

            // The first transaction rolled back ALL stock changes.
            // Save the captured payment for manual resolution.
            result = await finalizeCheckout(
                checkout._id,
                payment,
                capturedAt,
                config,
                error.message
            );
        }

        if (result.status === 'PaidNeedsReview') {
            console.warn(
                'Paid checkout needs review:',
                String(checkout._id)
            );
        }

        paymentLog('08 - WEBHOOK COMPLETED', {
            checkoutId: checkout._id.toString(),
            result: result.status,
            httpStatus: 200,
        });

        return res.status(200).json({
            success: true,
            received: true,
            status: result.status,
        });
    } catch (error) {
        paymentLogError('WEBHOOK PROCESSING FAILED', error);
        console.error('RAZORPAY WEBHOOK ERROR:', {
            message: error.message,
            statusCode: error.statusCode || 503,
            name: error.name,
            code: error.code,
        });

        return res.status(error.statusCode || 503).json({
            success: false,
            error:
                error.statusCode && error.statusCode < 500
                    ? error.message
                    : 'Unable to process payment webhook. Please retry.',
        });
    }
};


exports.getCheckoutStatus = async (req, res) => {
    try {
        res.set('Cache-Control', 'private, no-store');

        const userId = req.user?.id;
        const { checkoutId } = req.params;

        paymentLog('STATUS API - REQUEST', {
            checkoutId,
            authenticated: Boolean(userId),
        });

        if (!userId) {
            return res.status(401).json({
                success: false,
                error: 'Please sign in',
            });
        }

        if (!/^[a-f\d]{24}$/i.test(checkoutId)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid checkout ID',
            });
        }

        const checkout = await PaymentCheckout.findOne({
            _id: checkoutId,
            user: userId,
        })
            .select(
                'status order razorpayOrderId summary currency'
            )
            .lean();

        if (!checkout) {
            return res.status(404).json({
                success: false,
                error: 'Checkout not found',
            });
        }

        const orderPlaced =
            checkout.status === 'OrderPlaced' &&
            Boolean(checkout.order);

        paymentLog('STATUS API - DATABASE RESULT', {
            checkoutId,
            found: Boolean(checkout),
            status: checkout?.status,
            orderId: checkout?.order?.toString(),
        });

        return res.status(200).json({
            success: true,
            checkoutId: checkout._id,
            status: checkout.status,
            orderPlaced,
            orderId: orderPlaced ? checkout.order : null,
            paymentReviewRequired:
                checkout.status === 'PaidNeedsReview',
            summary: checkout.summary,
            currency: checkout.currency,
        });
    } catch (error) {
        console.error('getCheckoutStatus:', error);
        paymentLogError('STATUS API FAILED', error);

        return res.status(500).json({
            success: false,
            error: 'Unable to fetch checkout status',
        });
    }
};
