const Order = require("../models/order.model");
const Cart = require("../models/cart.model");
const Product = require("../models/product.model");

const PaymentCheckout = require('../models/paymentCheckout.model');
const Coupon = require('../models/coupon.model');

const {
    getRazorpayConfig,
    createRazorpayOrder,
} = require('../services/razorpay.service');

const {
    normalizeCheckoutAddress,
    buildCheckoutSnapshot,
} = require('../services/checkoutSnapshot.service');

const isValidOrderId = value =>
    typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);

const orderActionError = (message, statusCode = 400) =>
    Object.assign(new Error(message), { statusCode });

const sendOrderActionError = (res, error) => {
    console.error('Order action error:', error);

    return res.status(error.statusCode || 500).json({
        success: false,
        error: error.statusCode
            ? error.message
            : 'Unable to complete the request',
    });
};

// exports.placeOrder = async (req, res) => {
//     try {
//         const userId = req.user.id;
//         const { shippingAddress, paymentType } = req.body;

//         const orderError = message =>
//             Object.assign(new Error(message), { statusCode: 400 });

//         let populatedOrder;

//         await Order.db.transaction(async session => {
//             const cart = await Cart.findOne({ user: userId })
//                 .session(session);

//             if (!cart || cart.items.length === 0) {
//                 throw orderError("Cart is empty");
//             }

//             let subtotal = 0;
//             const orderItems = [];

//             for (const item of cart.items) {
//                 const qty = Number(item.quantity);

//                 if (!Number.isSafeInteger(qty) || qty < 1) {
//                     throw orderError("Invalid item quantity");
//                 }

//                 if (!item.dimensionId) {
//                     throw orderError(
//                         "Select a size / dimension for every cart item"
//                     );
//                 }

//                 // Check stock and decrement the SAME dimension atomically.
//                 const product = await Product.findOneAndUpdate(
//                     {
//                         _id: item.product,
//                         dimensions: {
//                             $elemMatch: {
//                                 _id: item.dimensionId,
//                                 stock: { $gte: qty },
//                             },
//                         },
//                     },
//                     {
//                         $inc: { "dimensions.$.stock": -qty },
//                     },
//                     {
//                         session,
//                         new: true,
//                     }
//                 );

//                 if (!product) {
//                     throw orderError(
//                         "A selected size / dimension is unavailable or has insufficient stock"
//                     );
//                 }

//                 const dimension = product.dimensions.find(
//                     option =>
//                         option._id.toString() === item.dimensionId.toString()
//                 );

//                 const price = Number(product.price?.finalPrice);

//                 if (!Number.isFinite(price) || price < 0) {
//                     throw orderError("A product has an invalid price");
//                 }

//                 subtotal += price * qty;

//                 orderItems.push({
//                     product: product._id,
//                     dimensionId: dimension._id,
//                     quantity: qty,
//                     size: dimension.size || null,
//                     priceAtPurchase: price,
//                 });
//             }

//             const shipping = subtotal > 5000 ? 0 : 100;
//             const totalCost = subtotal + shipping;

//             const [newOrder] = await Order.create(
//                 [{
//                     user: userId,
//                     items: orderItems,
//                     shippingAddress,
//                     paymentType,
//                     summary: {
//                         subtotal,
//                         shipping,
//                         totalCost,
//                     },
//                     status: 'Pending',
//                 }],
//                 { session }
//             );

//             await Cart.deleteOne(
//                 { _id: cart._id, user: userId },
//                 { session }
//             );

//             populatedOrder = await Order.findById(newOrder._id)
//                 .session(session)
//                 .populate({
//                     path: 'items.product',
//                     select: 'title thumbnail',
//                     options: { session },
//                 });
//         });

//         return res.status(201).json({
//             success: true,
//             order: populatedOrder,
//         });
//     } catch (error) {
//         console.error("Order Error:", error);

//         return res.status(error.statusCode || 500).json({
//             error: error.statusCode ? error.message : "Order failed",
//         });
//     }
// };

function replyWithCheckout(
    res,
    checkout,
    address,
    config,
    status = 200
) {
    if (
        JSON.stringify(checkout.shippingAddress) !==
        JSON.stringify(address) ||
        checkout.mode !== config.mode ||
        checkout.keyId !== config.keyId
    ) {
        return res.status(409).json({
            success: false,
            error: 'Checkout details changed. Use a new requestId.',
        });
    }

    if (checkout.status === 'OrderPlaced') {
        return res.status(200).json({
            success: true,
            checkoutId: checkout._id,
            status: checkout.status,
            orderId: checkout.order,
        });
    }

    if (checkout.status === 'Creating') {
        return res.status(202).json({
            success: true,
            checkoutId: checkout._id,
            status: 'Creating',
            message:
                'Checkout creation is in progress. Retry with the same requestId.',
        });
    }

    if (
        checkout.status !== 'AwaitingPayment' ||
        !checkout.razorpayOrderId
    ) {
        return res.status(409).json({
            success: false,
            checkoutId: checkout._id,
            status: checkout.status,
            error:
                'This checkout needs review before another payment attempt.',
        });
    }

    return res.status(status).json({
        success: true,
        checkoutId: checkout._id,
        status: checkout.status,
        razorpay: {
            keyId: checkout.keyId,
            orderId: checkout.razorpayOrderId,
            amount: checkout.amountPaise,
            currency: checkout.currency,
        },
        summary: checkout.summary,
    });
}

exports.createOrder = async (req, res) => {
    res.set('Cache-Control', 'private, no-store');

    let checkout;
    let remoteOrder;
    let providerCallStarted = false;

    try {
        const userId = req.user?.id;
        const body = req.body || {};

        if (!userId) {
            return res.status(401).json({
                success: false,
                error: 'Please sign in',
            });
        }

        if (
            typeof body.requestId !== 'string' ||
            !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(
                body.requestId
            )
        ) {
            throw Object.assign(
                new Error('A UUID requestId is required'),
                { statusCode: 400 }
            );
        }

        if (
            body.paymentType !== undefined &&
            body.paymentType !== 'Online'
        ) {
            throw Object.assign(
                new Error('Only online payments are supported'),
                { statusCode: 400 }
            );
        }

        const requestId = body.requestId.toLowerCase();

        const address = normalizeCheckoutAddress(
            body.shippingAddress
        );

        const config = getRazorpayConfig();

        await PaymentCheckout.init();

        const existing = await PaymentCheckout.findOne({
            user: userId,
            requestId,
        }).lean();

        if (existing) {
            return replyWithCheckout(
                res,
                existing,
                address,
                config
            );
        }

        try {
            await Order.db.transaction(async session => {
                const cart = await Cart.findOne({
                    user: userId,
                })
                    .session(session)
                    .populate({
                        path: 'items.product',
                        select: 'price dimensions isActive',
                    });

                if (!cart?.items?.length) {
                    throw Object.assign(
                        new Error('Cart is empty'),
                        { statusCode: 400 }
                    );
                }

                const couponCode = String(
                    cart.couponCode || ''
                )
                    .trim()
                    .toUpperCase();

                const coupon = couponCode
                    ? await Coupon.findOne({
                        code: couponCode,
                    })
                        .session(session)
                        .lean()
                    : null;

                const snapshot = buildCheckoutSnapshot(
                    cart,
                    coupon
                );

                [checkout] = await PaymentCheckout.create(
                    [{
                        user: userId,
                        cartId: cart._id,
                        requestId,
                        shippingAddress: address,
                        ...snapshot,
                        currency: 'INR',
                        mode: config.mode,
                        keyId: config.keyId,
                        status: 'Creating',
                    }],
                    { session }
                );
            });
        } catch (error) {
            // Another request with the same UUID may have won.
            if (error.code === 11000) {
                const saved = await PaymentCheckout.findOne({
                    user: userId,
                    requestId,
                }).lean();

                if (saved) {
                    return replyWithCheckout(
                        res,
                        saved,
                        address,
                        config
                    );
                }
            }

            throw error;
        }

        // Keep the provider request outside the DB transaction.
        providerCallStarted = true;

        remoteOrder = await createRazorpayOrder({
            checkoutId: String(checkout._id),
            amountPaise: checkout.amountPaise,
        });

        const updated = await PaymentCheckout.findOneAndUpdate(
            {
                _id: checkout._id,
                status: 'Creating',
                razorpayOrderId: { $exists: false },
            },
            {
                $set: {
                    razorpayOrderId: remoteOrder.id,
                    status: 'AwaitingPayment',
                    lastError: '',
                },
            },
            {
                new: true,
                runValidators: true,
            }
        ).lean();

        if (!updated) {
            const saved = await PaymentCheckout.findById(
                checkout._id
            ).lean();

            if (saved?.razorpayOrderId === remoteOrder.id) {
                return replyWithCheckout(
                    res,
                    saved,
                    address,
                    config
                );
            }

            throw Object.assign(
                new Error('Checkout changed during payment setup'),
                { statusCode: 409 }
            );
        }

        return replyWithCheckout(
            res,
            updated,
            address,
            config,
            201
        );
    } catch (error) {
        if (providerCallStarted && checkout) {
            try {
                await PaymentCheckout.updateOne(
                    {
                        _id: checkout._id,
                        status: 'Creating',
                    },
                    {
                        $set: {
                            status: 'CreationNeedsReview',
                            lastError:
                                'Payment order creation could not be confirmed',
                            ...(remoteOrder && {
                                razorpayOrderId: remoteOrder.id,
                            }),
                        },
                    }
                );
            } catch {
                console.error(
                    'Unable to save checkout review state:',
                    String(checkout._id)
                );
            }
        }

        console.error(
            'createOrder:',
            error.statusCode || 500
        );

        return res.status(error.statusCode || 500).json({
            success: false,
            ...(providerCallStarted && checkout && {
                checkoutId: checkout._id,
            }),
            error: error.statusCode
                ? error.message
                : 'Unable to create payment checkout. Please try again.',
        });
    }
};

exports.getMyOrders = async (req, res) => {
    try {
        const orders = await Order.find({ user: req.user.id })
            .populate('items.product', 'title thumbnail')
            .sort({ createdAt: -1 });

        res.status(200).json({ success: true, orders });
    } catch (error) {
        res.status(500).json({ error: "Internal server error" });
    }
};

// 1. Cancel an entire order and restore dimension stock.
exports.cancelOrder = async (req, res) => {
    try {
        const { orderId } = req.params;
        const userId = req.user.id;
        const reason = typeof req.body?.reason === 'string'
            ? req.body.reason.trim()
            : '';

        if (!isValidOrderId(orderId)) {
            throw orderActionError('Invalid order ID');
        }

        if (!reason || reason.length > 500) {
            throw orderActionError(
                'Enter a cancellation reason of up to 500 characters'
            );
        }

        let cancelledOrder;

        await Order.db.transaction(async session => {
            const order = await Order.findOne({
                _id: orderId,
                user: userId,
            }).session(session);

            if (!order) {
                throw orderActionError('Order not found', 404);
            }

            // Prevent restoring stock twice.
            if (order.status === 'Cancelled') {
                cancelledOrder = order;
                return;
            }

            if (!['Pending', 'Processing'].includes(order.status)) {
                throw orderActionError(
                    'This order can no longer be cancelled',
                    409
                );
            }

            cancelledOrder = await Order.findOneAndUpdate(
                {
                    _id: order._id,
                    user: userId,
                    status: { $in: ['Pending', 'Processing'] },
                },
                {
                    $set: {
                        status: 'Cancelled',
                        cancellationReason: reason,
                        cancelledAt: new Date(),
                    },
                },
                {
                    session,
                    new: true,
                    runValidators: true,
                }
            );

            if (!cancelledOrder) {
                throw orderActionError(
                    'Order status changed. Please refresh and try again.',
                    409
                );
            }

            for (const item of order.items) {
                const quantity = Number(item.quantity);

                if (
                    !item.dimensionId ||
                    !Number.isSafeInteger(quantity) ||
                    quantity < 1
                ) {
                    throw orderActionError(
                        'This order needs manual stock reconciliation. Please contact support.',
                        409
                    );
                }

                const result = await Product.updateOne(
                    {
                        _id: item.product,
                        'dimensions._id': item.dimensionId,
                    },
                    {
                        $inc: {
                            'dimensions.$.stock': quantity,
                        },
                    },
                    { session }
                );

                if (result.matchedCount !== 1) {
                    throw orderActionError(
                        'An ordered dimension no longer exists. Please contact support.',
                        409
                    );
                }
            }
        });

        await cancelledOrder.populate(
            'items.product',
            'title thumbnail'
        );

        return res.status(200).json({
            success: true,
            message: 'Order cancelled successfully',
            order: cancelledOrder,
        });
    } catch (error) {
        return sendOrderActionError(res, error);
    }
};

// 2. Shared handler for item-level return/exchange requests.
const createServiceRequest = async (req, res, type) => {
    try {
        const { orderId } = req.params;
        const { itemId, targetDimensionId } = req.body || {};
        const userId = req.user.id;

        const reason = typeof req.body?.reason === 'string'
            ? req.body.reason.trim()
            : '';

        if (
            !isValidOrderId(orderId) ||
            !isValidOrderId(itemId)
        ) {
            throw orderActionError('Invalid order or item ID');
        }

        if (!reason || reason.length > 500) {
            throw orderActionError(
                'Enter a reason of up to 500 characters'
            );
        }

        const order = await Order.findOne({
            _id: orderId,
            user: userId,
        });

        if (!order) {
            throw orderActionError('Order not found', 404);
        }

        if (order.status !== 'Delivered') {
            throw orderActionError(
                'Return and exchange requests are available after delivery',
                409
            );
        }

        const item = order.items.id(itemId);

        if (!item) {
            throw orderActionError(
                'This item does not belong to the order',
                404
            );
        }

        const quantity = Number(item.quantity);

        if (!Number.isSafeInteger(quantity) || quantity < 1) {
            throw orderActionError(
                'This order item needs manual review',
                409
            );
        }

        const requestData = {
            itemId: item._id,
            type,
            quantity,
            reason,
            status: 'Requested',
            requestedAt: new Date(),
        };

        if (type === 'Exchange') {
            if (!isValidOrderId(targetDimensionId)) {
                throw orderActionError(
                    'Select a valid replacement dimension'
                );
            }

            if (
                String(item.dimensionId) ===
                targetDimensionId.toLowerCase()
            ) {
                throw orderActionError(
                    'Select a different replacement dimension'
                );
            }

            const product = await Product.findById(item.product);

            const dimension = product?.dimensions?.find(
                option =>
                    String(option._id) ===
                    targetDimensionId.toLowerCase()
            );

            if (!dimension) {
                throw orderActionError(
                    'Replacement dimension not found',
                    404
                );
            }

            const stock = Number(dimension.stock);

            if (
                !Number.isSafeInteger(stock) ||
                stock < quantity
            ) {
                throw orderActionError(
                    'The replacement dimension has insufficient stock',
                    409
                );
            }

            requestData.targetDimensionId = dimension._id;
            requestData.targetDimensions = {
                size: dimension.size,
                width: dimension.width,
                length: dimension.length,
            };
        }

        // Atomically prevent duplicate active/completed requests.
        // Rejected requests may be submitted again.
        const updatedOrder = await Order.findOneAndUpdate(
            {
                _id: order._id,
                user: userId,
                status: 'Delivered',
                serviceRequests: {
                    $not: {
                        $elemMatch: {
                            itemId: item._id,
                            status: {
                                $in: [
                                    'Requested',
                                    'Approved',
                                    'Completed',
                                ],
                            },
                        },
                    },
                },
            },
            {
                $push: {
                    serviceRequests: requestData,
                },
            },
            {
                new: true,
                runValidators: true,
            }
        ).populate('items.product', 'title thumbnail');

        if (!updatedOrder) {
            throw orderActionError(
                'This item already has a request, or the order status changed',
                409
            );
        }

        return res.status(201).json({
            success: true,
            message: `${type} request submitted successfully`,
            order: updatedOrder,
        });
    } catch (error) {
        return sendOrderActionError(res, error);
    }
};

exports.requestReturn = (req, res) =>
    createServiceRequest(req, res, 'Return');

exports.requestExchange = (req, res) =>
    createServiceRequest(req, res, 'Exchange');