const mongoose = require('mongoose');
const Order = require('../models/order.model');

const ORDER_STATUSES = [
    'Pending',
    'Processing',
    'Shipped',
    'Delivered',
    'Cancelled',
];

const validId = value =>
    typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);

const populateOrder = query =>
    query
        .populate('user', 'firstName lastName phone email')
        .populate('items.product', 'title thumbnail');

// 1. Get all customers' orders.
exports.getAllOrders = async (req, res) => {
    try {
        const page = Number(req.query.page ?? 1);
        const limit = Number(req.query.limit ?? 20);
        const skip = (page - 1) * limit;

        if (
            !Number.isSafeInteger(page) ||
            page < 1 ||
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > 100 ||
            !Number.isSafeInteger(skip)
        ) {
            return res.status(400).json({
                success: false,
                error: 'Invalid pagination. Limit must be between 1 and 100',
            });
        }

        const query = {};
        const { status } = req.query;

        if (status && status !== 'All') {
            if (!ORDER_STATUSES.includes(status)) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid order status',
                });
            }

            query.status = status;
        }

        // Search by full order ID or shipping recipient details.
        const search = typeof req.query.search === 'string'
            ? req.query.search.trim()
            : '';

        if (search) {
            const escapedSearch = search.replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&'
            );

            const regex = new RegExp(escapedSearch, 'i');

            query.$or = [
                { 'shippingAddress.firstName': regex },
                { 'shippingAddress.lastName': regex },
                { 'shippingAddress.fullName': regex },
                { 'shippingAddress.phone': regex },
                { 'shippingAddress.email': regex },
            ];

            if (validId(search)) {
                query.$or.push({
                    _id: new mongoose.Types.ObjectId(search),
                });
            }
        }

        const [orders, total] = await Promise.all([
            populateOrder(
                Order.find(query)
                    .sort({ createdAt: -1, _id: -1 })
                    .skip(skip)
                    .limit(limit)
            ).lean(),

            Order.countDocuments(query),
        ]);

        return res.status(200).json({
            success: true,
            count: orders.length,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
            hasMore: skip + orders.length < total,
            orders,
        });
    } catch (error) {
        console.error('getAllOrders error:', error);

        return res.status(500).json({
            success: false,
            error: 'Unable to fetch orders',
        });
    }
};

// 2. Get one order, including items and service requests.
exports.getAdminOrderDetails = async (req, res) => {
    try {
        const { orderId } = req.params;

        if (!validId(orderId)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid order ID',
            });
        }

        const order = await populateOrder(
            Order.findById(orderId)
        ).lean();

        if (!order) {
            return res.status(404).json({
                success: false,
                error: 'Order not found',
            });
        }

        return res.status(200).json({
            success: true,
            order,
        });
    } catch (error) {
        console.error('getAdminOrderDetails error:', error);

        return res.status(500).json({
            success: false,
            error: 'Unable to fetch order details',
        });
    }
};

// 3. Move an order forward through its fulfillment stages.
exports.updateOrderStatus = async (req, res) => {
    try {
        const { orderId } = req.params;
        const { status } = req.body || {};

        if (!validId(orderId)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid order ID',
            });
        }

        const previousStatus = {
            Processing: 'Pending',
            Shipped: 'Processing',
            Delivered: 'Shipped',
        };

        if (
            typeof status !== 'string' ||
            !Object.prototype.hasOwnProperty.call(previousStatus, status)
        ) {
            return res.status(400).json({
                success: false,
                error: 'Status must be Processing, Shipped or Delivered',
            });
        }

        const changes = { status };

        if (status === 'Delivered') {
            changes.deliveredAt = new Date();
        }

        // Only update if the current stage matches.
        const order = await populateOrder(
            Order.findOneAndUpdate(
                {
                    _id: orderId,
                    status: previousStatus[status],
                },
                {
                    $set: changes,
                },
                {
                    new: true,
                    runValidators: true,
                }
            )
        );

        if (!order) {
            const existingOrder = await Order.findById(orderId)
                .select('status')
                .lean();

            if (!existingOrder) {
                return res.status(404).json({
                    success: false,
                    error: 'Order not found',
                });
            }

            return res.status(409).json({
                success: false,
                error: `Cannot change ${existingOrder.status} to ${status}. Refresh the order before continuing.`,
            });
        }

        return res.status(200).json({
            success: true,
            message: 'Order status updated successfully',
            order,
        });
    } catch (error) {
        console.error('updateOrderStatus error:', error);

        return res.status(500).json({
            success: false,
            error: 'Unable to update order status',
        });
    }
};