const Order = require('../models/order.model');

const {
    shiprocketRequest,
    createShiprocketOrder,
} = require('../services/shiprocket.service');

const {
    buildShiprocketOrderPayload,
} = require('../services/shiprocketPayload.service');

const positiveNumber = value => {
    if (
        !['number', 'string'].includes(typeof value) ||
        (typeof value === 'string' && !value.trim())
    ) {
        return NaN;
    }

    const number = Number(value);

    return Number.isFinite(number) && number > 0
        ? number
        : NaN;
};

const pincodeString = value =>
    ['number', 'string'].includes(typeof value)
        ? String(value).trim()
        : '';

const getOrderShippingRates = async (req, res) => {
    try {
        const { orderId } = req.params;

        if (
            typeof orderId !== 'string' ||
            !/^[a-f\d]{24}$/i.test(orderId)
        ) {
            return res.status(400).json({
                error: 'Invalid order ID',
            });
        }

        const input = req.body?.packageDetails;

        if (
            !input ||
            typeof input !== 'object' ||
            Array.isArray(input)
        ) {
            return res.status(400).json({
                error: 'Package weight and dimensions are required',
            });
        }

        const packageDetails = {
            weightKg: positiveNumber(input.weightKg),
            lengthCm: positiveNumber(input.lengthCm),
            breadthCm: positiveNumber(input.breadthCm),
            heightCm: positiveNumber(input.heightCm),
        };

        if (!Object.values(packageDetails).every(Number.isFinite)) {
            return res.status(400).json({
                error: 'Package weight and dimensions must be positive numbers',
            });
        }

        const order = await Order.findById(orderId)
            .select('shippingAddress paymentType summary status')
            .lean();

        if (!order) {
            return res.status(404).json({
                error: 'Order not found',
            });
        }

        if (!['Pending', 'Processing'].includes(order.status)) {
            return res.status(409).json({
                error: 'Shipping rates are available before dispatch',
            });
        }

        if (order.paymentType !== 'Online') {
            return res.status(400).json({
                error: 'Only online-payment orders are supported',
            });
        }

        const country = order.shippingAddress?.country;

        if (
            country !== undefined &&
            (
                typeof country !== 'string' ||
                country.trim().toLowerCase() !== 'india'
            )
        ) {
            return res.status(400).json({
                error: 'This shipping flow supports Indian delivery addresses',
            });
        }

        const pickupPostcode = pincodeString(
            process.env.SHIPROCKET_PICKUP_POSTCODE
        );

        const deliveryPostcode = pincodeString(
            order.shippingAddress?.pincode
        );

        if (!/^[1-9]\d{5}$/.test(pickupPostcode)) {
            return res.status(500).json({
                error: 'Pickup postcode is not configured correctly',
            });
        }

        if (!/^[1-9]\d{5}$/.test(deliveryPostcode)) {
            return res.status(400).json({
                error: 'The order has an invalid delivery pincode',
            });
        }

        const orderValue = Number(order.summary?.totalCost);

        if (!Number.isFinite(orderValue) || orderValue < 0) {
            return res.status(400).json({
                error: 'The order has an invalid total',
            });
        }

        const response = await shiprocketRequest(
            'GET',
            '/courier/serviceability/',
            {
                params: {
                    pickup_postcode: Number(pickupPostcode),
                    delivery_postcode: Number(deliveryPostcode),
                    cod: 0,
                    weight: packageDetails.weightKg,
                    length: packageDetails.lengthCm,
                    breadth: packageDetails.breadthCm,
                    height: packageDetails.heightCm,
                    declared_value: Math.ceil(orderValue),
                },
            }
        );

        const couriers =
            response?.data?.available_courier_companies;

        if (!Array.isArray(couriers)) {
            return res.status(502).json({
                error: 'Unexpected courier availability response',
            });
        }

        return res.status(200).json({
            success: true,
            serviceable: couriers.length > 0,
            packageDetails,
            couriers,
            recommendedCourierId:
                response.data.recommended_courier_company_id ?? null,
        });
    } catch (error) {
        console.error('getOrderShippingRates:', error.message);

        return res.status(502).json({
            error: 'Unable to fetch shipping rates. Please try again.',
        });
    }
};

const createOrderShipment = async (req, res) => {
    let claim;
    let created;

    try {
        const { orderId } = req.params;

        if (
            typeof orderId !== 'string' ||
            !/^[a-f\d]{24}$/i.test(orderId)
        ) {
            return res.status(400).json({
                error: 'Invalid order ID',
            });
        }

        const order = await Order.findById(orderId)
            .populate('items.product', 'title sku price.currency')
            .populate('user', 'email');

        if (!order) {
            return res.status(404).json({
                error: 'Order not found',
            });
        }

        const shipping = order.shipping || {};

        // Repeated requests return the existing shipment.
        if (
            shipping.shiprocketOrderId &&
            shipping.shipmentId
        ) {
            return res.status(200).json({
                success: true,
                message: 'Shiprocket order already exists',
                shipping,
            });
        }

        if (
            shipping.shiprocketOrderId ||
            shipping.shipmentId ||
            !['NotCreated', undefined].includes(
                shipping.bookingStatus
            )
        ) {
            return res.status(409).json({
                error:
                    'Shipment creation is underway or requires review. Do not retry automatically.',
            });
        }

        // Validates payment, address, items, totals and measurements.
        const payload = buildShiprocketOrderPayload(
            order,
            req.body?.packageDetails
        );

        const startedAt = new Date();

        // Claim the operation atomically before contacting Shiprocket.
        claim = await Order.findOneAndUpdate(
            {
                _id: order._id,
                updatedAt: order.updatedAt,
                status: {
                    $in: ['Pending', 'Processing'],
                },
                paymentType: 'Online',
                paymentStatus: 'Paid',

                'shipping.shiprocketOrderId': {
                    $exists: false,
                },
                'shipping.shipmentId': {
                    $exists: false,
                },

                $or: [
                    {
                        'shipping.bookingStatus': 'NotCreated',
                    },
                    {
                        'shipping.bookingStatus': {
                            $exists: false,
                        },
                    },
                ],
            },
            {
                $set: {
                    'shipping.sourceOrderId': payload.order_id,
                    'shipping.bookingStatus': 'Creating',
                    'shipping.bookingStartedAt': startedAt,
                    'shipping.lastOperation': 'CreateOrder',
                    'shipping.lastError': '',

                    'shipping.pickupLocation':
                        payload.pickup_location,

                    'shipping.packageDetails': {
                        weightKg: payload.weight,
                        lengthCm: payload.length,
                        breadthCm: payload.breadth,
                        heightCm: payload.height,
                    },
                },
            },
            {
                new: true,
                runValidators: true,
            }
        );

        if (!claim) {
            return res.status(409).json({
                error:
                    'Order changed or shipment creation already started. Refresh the order.',
            });
        }

        // External calls stay outside MongoDB transactions.
        created = await createShiprocketOrder(payload);

        const saved = await Order.findOneAndUpdate(
            {
                _id: claim._id,
                status: {
                    $in: ['Pending', 'Processing'],
                },
                paymentType: 'Online',
                paymentStatus: 'Paid',

                'shipping.sourceOrderId': payload.order_id,
                'shipping.bookingStatus': 'Creating',
                'shipping.bookingStartedAt': startedAt,
            },
            {
                $set: {
                    'shipping.shiprocketOrderId':
                        created.shiprocketOrderId,

                    'shipping.shipmentId':
                        created.shipmentId,

                    'shipping.bookingStatus': 'Created',
                    'shipping.lastError': '',
                },
            },
            {
                new: true,
                runValidators: true,
            }
        );

        if (!saved) {
            throw new Error(
                'Shiprocket order created, but local order changed'
            );
        }

        return res.status(201).json({
            success: true,
            message: 'Shiprocket order created successfully',
            shipping: saved.shipping,
        });
    } catch (error) {
        if (claim) {
            const changes = {
                'shipping.bookingStatus': 'NeedsReview',

                'shipping.lastError': created
                    ? 'Remote order created; local confirmation requires review'
                    : 'Creation outcome requires review before another attempt',
            };

            // Preserve known IDs if local confirmation failed.
            if (created) {
                changes['shipping.shiprocketOrderId'] =
                    created.shiprocketOrderId;

                changes['shipping.shipmentId'] =
                    created.shipmentId;
            }

            try {
                await Order.updateOne(
                    {
                        _id: claim._id,

                        'shipping.sourceOrderId':
                            claim.shipping.sourceOrderId,

                        'shipping.bookingStatus': 'Creating',

                        'shipping.bookingStartedAt':
                            claim.shipping.bookingStartedAt,
                    },
                    {
                        $set: changes,
                    },
                    {
                        runValidators: true,
                    }
                );
            } catch {
                console.error(
                    'Shipment review state could not be saved for order:',
                    String(claim._id)
                );
            }
        }

        console.error(
            'createOrderShipment:',
            error.message
        );

        return res
            .status(claim ? 502 : (error.statusCode || 500))
            .json({
                error: claim
                    ? 'Shipment creation needs review. Check Shiprocket before retrying.'
                    : error.statusCode
                        ? error.message
                        : 'Unable to create shipment',
            });
    }
};

module.exports = { getOrderShippingRates, createOrderShipment };