const Order = require("../models/order.model");
const Cart = require("../models/cart.model");
const Product = require("../models/product.model");

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

exports.placeOrder = async (req, res) => {
    try {
        const userId = req.user.id;
        const { shippingAddress, paymentType } = req.body;

        const orderError = message =>
            Object.assign(new Error(message), { statusCode: 400 });

        let populatedOrder;

        await Order.db.transaction(async session => {
            const cart = await Cart.findOne({ user: userId })
                .session(session);

            if (!cart || cart.items.length === 0) {
                throw orderError("Cart is empty");
            }

            let subtotal = 0;
            const orderItems = [];

            for (const item of cart.items) {
                const qty = Number(item.quantity);

                if (!Number.isSafeInteger(qty) || qty < 1) {
                    throw orderError("Invalid item quantity");
                }

                if (!item.dimensionId) {
                    throw orderError(
                        "Select a size / dimension for every cart item"
                    );
                }

                // Check stock and decrement the SAME dimension atomically.
                const product = await Product.findOneAndUpdate(
                    {
                        _id: item.product,
                        dimensions: {
                            $elemMatch: {
                                _id: item.dimensionId,
                                stock: { $gte: qty },
                            },
                        },
                    },
                    {
                        $inc: { "dimensions.$.stock": -qty },
                    },
                    {
                        session,
                        new: true,
                    }
                );

                if (!product) {
                    throw orderError(
                        "A selected size / dimension is unavailable or has insufficient stock"
                    );
                }

                const dimension = product.dimensions.find(
                    option =>
                        option._id.toString() === item.dimensionId.toString()
                );

                const price = Number(product.price?.finalPrice);

                if (!Number.isFinite(price) || price < 0) {
                    throw orderError("A product has an invalid price");
                }

                subtotal += price * qty;

                orderItems.push({
                    product: product._id,
                    dimensionId: dimension._id,
                    quantity: qty,
                    size: dimension.size || null,
                    priceAtPurchase: price,
                });
            }

            const shipping = subtotal > 5000 ? 0 : 100;
            const totalCost = subtotal + shipping;

            const [newOrder] = await Order.create(
                [{
                    user: userId,
                    items: orderItems,
                    shippingAddress,
                    paymentType,
                    summary: {
                        subtotal,
                        shipping,
                        totalCost,
                    },
                    status: 'Pending',
                }],
                { session }
            );

            await Cart.deleteOne(
                { _id: cart._id, user: userId },
                { session }
            );

            populatedOrder = await Order.findById(newOrder._id)
                .session(session)
                .populate({
                    path: 'items.product',
                    select: 'title thumbnail',
                    options: { session },
                });
        });

        return res.status(201).json({
            success: true,
            order: populatedOrder,
        });
    } catch (error) {
        console.error("Order Error:", error);

        return res.status(error.statusCode || 500).json({
            error: error.statusCode ? error.message : "Order failed",
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