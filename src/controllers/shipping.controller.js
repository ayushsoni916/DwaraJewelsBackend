const Order = require('../models/order.model');
const crypto = require('crypto');

const {
    shiprocketRequest,
    createShiprocketOrder,
    assignShiprocketAwb,
    requestShiprocketPickup,
    generateShiprocketLabel,
    generateShiprocketManifest,
    fetchShiprocketTracking,
    getShiprocketShipmentDetails,
    cancelShiprocketShipment
} = require('../services/shiprocket.service');

const {
    buildShiprocketOrderPayload,
} = require('../services/shiprocketPayload.service');

const parseShiprocketPickupDate = value => {
    if (typeof value !== 'string') return null;

    const match = value.trim().match(
        /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:\d{2})?)?$/
    );

    if (!match) return null;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4] || 0);
    const minute = Number(match[5] || 0);
    const second = Number(match[6] || 0);

    const milliseconds = Number(
        (match[7] || '').padEnd(3, '0').slice(0, 3)
    );

    const calendar = new Date(
        Date.UTC(
            year,
            month - 1,
            day,
            hour,
            minute,
            second,
            milliseconds
        )
    );

    if (
        calendar.getUTCFullYear() !== year ||
        calendar.getUTCMonth() !== month - 1 ||
        calendar.getUTCDate() !== day ||
        calendar.getUTCHours() !== hour ||
        calendar.getUTCMinutes() !== minute ||
        calendar.getUTCSeconds() !== second
    ) {
        return null;
    }

    const zone = match[8];
    let offset = 330;

    if (zone === 'Z') {
        offset = 0;
    } else if (zone) {
        const hours = Number(zone.slice(1, 3));
        const minutes = Number(zone.slice(4, 6));

        if (hours > 23 || minutes > 59) return null;

        offset =
            (hours * 60 + minutes) *
            (zone[0] === '+' ? 1 : -1);
    }

    return new Date(
        calendar.getTime() - offset * 60000
    );
};

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

const shippingError = (message, statusCode = 400) =>
    Object.assign(new Error(message), { statusCode });

const assignOrderAwb = async (req, res) => {
    let claim;
    let assigned;

    try {
        const { orderId } = req.params;
        const courierId = positiveNumber(req.body?.courierId);

        if (
            typeof orderId !== 'string' ||
            !/^[a-f\d]{24}$/i.test(orderId)
        ) {
            throw shippingError('Invalid order ID');
        }

        if (!Number.isSafeInteger(courierId)) {
            throw shippingError('Select a valid courier');
        }

        const order = await Order.findById(orderId)
            .select(
                'shipping shippingAddress paymentType paymentStatus status updatedAt'
            )
            .lean();

        if (!order) {
            throw shippingError('Order not found', 404);
        }

        if (!['Pending', 'Processing'].includes(order.status)) {
            throw shippingError(
                'This order is no longer awaiting dispatch',
                409
            );
        }

        if (
            order.paymentType !== 'Online' ||
            order.paymentStatus !== 'Paid'
        ) {
            throw shippingError(
                'Confirmed online payment is required'
            );
        }

        const shipping = order.shipping || {};

        if (
            [
                8, 9, 10, 12, 14, 16, 24, 25,
                40, 41, 44, 45, 46, 47,
            ].includes(shipping.shipmentStatusId)
        ) {
            throw shippingError(
                'The courier reported a cancellation, return, or exception. Review the shipment first.',
                409
            );
        }

        if (shipping.bookingStatus !== 'Created') {
            throw shippingError(
                'Create the Shiprocket order first, or resolve the pending shipping operation',
                409
            );
        }

        if (
            !Number.isSafeInteger(shipping.shiprocketOrderId) ||
            shipping.shiprocketOrderId < 1 ||
            !Number.isSafeInteger(shipping.shipmentId) ||
            shipping.shipmentId < 1
        ) {
            throw shippingError(
                'The saved Shiprocket IDs need review',
                409
            );
        }

        if (shipping.awbCode) {
            return res.status(200).json({
                success: true,
                message: 'AWB already assigned',
                shipping,
            });
        }

        const pickup = pincodeString(
            process.env.SHIPROCKET_PICKUP_POSTCODE
        );

        const delivery = pincodeString(
            order.shippingAddress?.pincode
        );

        if (
            !/^[1-9]\d{5}$/.test(pickup) ||
            !/^[1-9]\d{5}$/.test(delivery)
        ) {
            throw shippingError(
                'Valid pickup and delivery pincodes are required'
            );
        }

        // Use the saved provider order and its parcel details.
        const rates = await shiprocketRequest(
            'GET',
            '/courier/serviceability/',
            {
                params: {
                    pickup_postcode: Number(pickup),
                    delivery_postcode: Number(delivery),
                    order_id: shipping.shiprocketOrderId,
                },
            }
        );

        const couriers =
            rates?.data?.available_courier_companies;

        if (!Array.isArray(couriers)) {
            throw shippingError(
                'Unexpected courier availability response',
                502
            );
        }

        const available = couriers.some(
            item =>
                Number(item.courier_company_id) === courierId
        );

        if (!available) {
            throw shippingError(
                'The selected courier is unavailable for this shipment'
            );
        }

        const startedAt = new Date();

        // Atomically prevent concurrent assignment requests.
        claim = await Order.findOneAndUpdate(
            {
                _id: order._id,
                updatedAt: order.updatedAt,
                status: {
                    $in: ['Pending', 'Processing'],
                },
                paymentType: 'Online',
                paymentStatus: 'Paid',

                'shipping.bookingStatus': 'Created',

                'shipping.shiprocketOrderId':
                    shipping.shiprocketOrderId,

                'shipping.shipmentId': shipping.shipmentId,

                $or: [
                    {
                        'shipping.awbCode': {
                            $exists: false,
                        },
                    },
                    { 'shipping.awbCode': null },
                    { 'shipping.awbCode': '' },
                ],
            },
            {
                $set: {
                    'shipping.bookingStatus': 'Creating',
                    'shipping.bookingStartedAt': startedAt,
                    'shipping.lastOperation': 'AssignAWB',
                    'shipping.lastError': '',
                    'shipping.courierId': courierId,
                },
            },
            {
                new: true,
                runValidators: true,
            }
        );

        if (!claim) {
            throw shippingError(
                'Order changed or another shipping operation started. Refresh the order.',
                409
            );
        }

        assigned = await assignShiprocketAwb(
            shipping.shipmentId,
            courierId
        );

        if (assigned.courierId !== courierId) {
            throw new Error(
                'Assigned courier differs from the selected courier'
            );
        }

        const saved = await Order.findOneAndUpdate(
            {
                _id: claim._id,
                status: {
                    $in: ['Pending', 'Processing'],
                },
                paymentType: 'Online',
                paymentStatus: 'Paid',

                'shipping.shipmentId': shipping.shipmentId,
                'shipping.bookingStatus': 'Creating',
                'shipping.lastOperation': 'AssignAWB',
                'shipping.bookingStartedAt': startedAt,
            },
            {
                $set: {
                    'shipping.awbCode': assigned.awbCode,
                    'shipping.courierId': assigned.courierId,
                    'shipping.courierName': assigned.courierName,
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
                'AWB assigned, but local confirmation failed'
            );
        }

        return res.status(200).json({
            success: true,
            message: 'Courier selected and AWB assigned',
            shipping: saved.shipping,
        });
    } catch (error) {
        if (claim) {
            const changes = {
                'shipping.bookingStatus': 'NeedsReview',

                'shipping.lastError': assigned
                    ? 'AWB assigned; courier or local confirmation requires review'
                    : 'AWB assignment outcome requires review before retrying',
            };

            // Preserve a known AWB even if confirmation failed.
            if (assigned) {
                changes['shipping.awbCode'] = assigned.awbCode;
                changes['shipping.courierId'] = assigned.courierId;
                changes['shipping.courierName'] =
                    assigned.courierName;
            }

            try {
                await Order.updateOne(
                    {
                        _id: claim._id,

                        'shipping.shipmentId':
                            claim.shipping.shipmentId,

                        'shipping.bookingStatus': 'Creating',
                        'shipping.lastOperation': 'AssignAWB',

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
                    'AWB review state could not be saved for order:',
                    String(claim._id)
                );
            }
        }

        console.error('assignOrderAwb:', error.message);

        return res
            .status(claim ? 502 : (error.statusCode || 502))
            .json({
                error: claim
                    ? 'AWB assignment needs review. Check Shiprocket before retrying.'
                    : error.statusCode
                        ? error.message
                        : 'Unable to assign AWB',
            });
    }
};

const requestOrderPickup = async (req, res) => {
    let claim;
    let pickup;
    let scheduledAt;

    try {
        const { orderId } = req.params;

        if (
            typeof orderId !== 'string' ||
            !/^[a-f\d]{24}$/i.test(orderId)
        ) {
            throw shippingError('Invalid order ID');
        }

        const order = await Order.findById(orderId)
            .select(
                'shipping paymentType paymentStatus status updatedAt'
            )
            .lean();

        if (!order) {
            throw shippingError('Order not found', 404);
        }

        if (!['Pending', 'Processing'].includes(order.status)) {
            throw shippingError(
                'This order is no longer awaiting dispatch',
                409
            );
        }

        if (
            order.paymentType !== 'Online' ||
            order.paymentStatus !== 'Paid'
        ) {
            throw shippingError(
                'Confirmed online payment is required'
            );
        }

        const shipping = order.shipping || {};

        if (
            [
                8, 9, 10, 12, 14, 16, 24, 25,
                40, 41, 44, 45, 46, 47,
            ].includes(shipping.shipmentStatusId)
        ) {
            throw shippingError(
                'The courier reported a cancellation, return, or exception. Review the shipment first.',
                409
            );
        }

        if (shipping.bookingStatus !== 'Created') {
            throw shippingError(
                'Resolve the pending shipping operation first',
                409
            );
        }

        if (
            !Number.isSafeInteger(shipping.shipmentId) ||
            shipping.shipmentId < 1 ||
            typeof shipping.awbCode !== 'string' ||
            !shipping.awbCode.trim()
        ) {
            throw shippingError(
                'Assign an AWB before requesting pickup',
                409
            );
        }

        if (shipping.pickupRequestedAt) {
            return res.status(200).json({
                success: true,
                message: 'Pickup already requested',
                shipping,
            });
        }

        const startedAt = new Date();

        claim = await Order.findOneAndUpdate(
            {
                _id: order._id,
                updatedAt: order.updatedAt,
                status: {
                    $in: ['Pending', 'Processing'],
                },
                paymentType: 'Online',
                paymentStatus: 'Paid',

                'shipping.bookingStatus': 'Created',
                'shipping.shipmentId': shipping.shipmentId,
                'shipping.awbCode': shipping.awbCode,

                $or: [
                    {
                        'shipping.pickupRequestedAt': {
                            $exists: false,
                        },
                    },
                    {
                        'shipping.pickupRequestedAt': null,
                    },
                ],
            },
            {
                $set: {
                    'shipping.bookingStatus': 'Creating',
                    'shipping.bookingStartedAt': startedAt,
                    'shipping.lastOperation': 'RequestPickup',
                    'shipping.lastError': '',
                },
            },
            {
                new: true,
                runValidators: true,
            }
        );

        if (!claim) {
            throw shippingError(
                'Order changed or another shipping operation started. Refresh the order.',
                409
            );
        }

        pickup = await requestShiprocketPickup(
            shipping.shipmentId
        );

        scheduledAt = parseShiprocketPickupDate(
            pickup.pickupScheduledDate
        );

        const changes = {
            'shipping.bookingStatus': 'Created',
            'shipping.pickupRequestedAt': startedAt,
            'shipping.lastError': '',
        };

        if (scheduledAt) {
            changes['shipping.pickupScheduledAt'] = scheduledAt;
        }

        const saved = await Order.findOneAndUpdate(
            {
                _id: claim._id,
                status: {
                    $in: ['Pending', 'Processing'],
                },
                paymentType: 'Online',
                paymentStatus: 'Paid',

                'shipping.shipmentId': shipping.shipmentId,
                'shipping.awbCode': shipping.awbCode,
                'shipping.bookingStatus': 'Creating',
                'shipping.lastOperation': 'RequestPickup',
                'shipping.bookingStartedAt': startedAt,
            },
            {
                $set: changes,
            },
            {
                new: true,
                runValidators: true,
            }
        );

        if (!saved) {
            throw new Error(
                'Pickup accepted, but local confirmation failed'
            );
        }

        return res.status(200).json({
            success: true,
            message: 'Pickup requested successfully',
            shipping: saved.shipping,
        });
    } catch (error) {
        if (claim) {
            const changes = {
                'shipping.bookingStatus': 'NeedsReview',

                'shipping.lastError': pickup
                    ? 'Pickup accepted; local confirmation requires review'
                    : 'Pickup request outcome requires review before retrying',
            };

            // Preserve confirmation if the provider accepted pickup.
            if (pickup) {
                changes['shipping.pickupRequestedAt'] =
                    claim.shipping.bookingStartedAt;

                if (scheduledAt) {
                    changes['shipping.pickupScheduledAt'] =
                        scheduledAt;
                }
            }

            try {
                await Order.updateOne(
                    {
                        _id: claim._id,

                        'shipping.shipmentId':
                            claim.shipping.shipmentId,

                        'shipping.awbCode':
                            claim.shipping.awbCode,

                        'shipping.bookingStatus': 'Creating',
                        'shipping.lastOperation': 'RequestPickup',

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
                    'Pickup review state could not be saved for order:',
                    String(claim._id)
                );
            }
        }

        console.error('requestOrderPickup:', error.message);

        return res
            .status(claim ? 502 : (error.statusCode || 502))
            .json({
                error: claim
                    ? 'Pickup request needs review. Check Shiprocket before retrying.'
                    : error.statusCode
                        ? error.message
                        : 'Unable to request pickup',
            });
    }
};

const generateOrderDocument = type => async (req, res) => {
    const isManifest = type === 'manifest';
    const urlField = isManifest ? 'manifestUrl' : 'labelUrl';
    const title = isManifest ? 'Manifest' : 'Label';

    try {
        const { orderId } = req.params;

        if (
            typeof orderId !== 'string' ||
            !/^[a-f\d]{24}$/i.test(orderId)
        ) {
            throw shippingError('Invalid order ID');
        }

        const order = await Order.findById(orderId)
            .select(
                'shipping paymentType paymentStatus status'
            )
            .lean();

        if (!order) {
            throw shippingError('Order not found', 404);
        }

        if (order.status === 'Cancelled') {
            throw shippingError(
                'Documents cannot be generated for a cancelled order',
                409
            );
        }

        if (
            order.paymentType !== 'Online' ||
            order.paymentStatus !== 'Paid'
        ) {
            throw shippingError(
                'Confirmed online payment is required'
            );
        }

        const shipping = order.shipping || {};

        if (
            !Number.isSafeInteger(shipping.shipmentId) ||
            shipping.shipmentId < 1 ||
            typeof shipping.awbCode !== 'string' ||
            !shipping.awbCode.trim()
        ) {
            throw shippingError(
                'Assign an AWB before generating documents',
                409
            );
        }

        if (isManifest && !shipping.pickupRequestedAt) {
            throw shippingError(
                'Request pickup before generating the manifest',
                409
            );
        }

        const existingUrl =
            typeof shipping[urlField] === 'string'
                ? shipping[urlField].trim()
                : '';

        if (existingUrl) {
            return res.status(200).json({
                success: true,
                message: `${title} already available`,
                [urlField]: existingUrl,
                shipping,
            });
        }

        if (shipping.bookingStatus !== 'Created') {
            throw shippingError(
                'Resolve the pending shipping operation first',
                409
            );
        }

        const generate = isManifest
            ? generateShiprocketManifest
            : generateShiprocketLabel;

        const document = await generate(
            shipping.shipmentId
        );

        const filter = {
            _id: order._id,
            status: {
                $ne: 'Cancelled',
            },
            paymentType: 'Online',
            paymentStatus: 'Paid',

            'shipping.shipmentId': shipping.shipmentId,
            'shipping.awbCode': shipping.awbCode,
        };

        if (isManifest) {
            filter['shipping.pickupRequestedAt'] =
                shipping.pickupRequestedAt;
        }

        // Update only this document URL.
        const saved = await Order.findOneAndUpdate(
            filter,
            {
                $set: {
                    [`shipping.${urlField}`]: document.url,
                },
            },
            {
                new: true,
                runValidators: true,
            }
        );

        if (!saved) {
            throw shippingError(
                'Order shipping details changed. Refresh the order.',
                409
            );
        }

        return res.status(200).json({
            success: true,
            message: `${title} generated successfully`,
            [urlField]: saved.shipping[urlField],
            shipping: saved.shipping,
        });
    } catch (error) {
        console.error(
            `generateOrder${title}:`,
            error.message
        );

        return res
            .status(error.statusCode || 502)
            .json({
                error: error.statusCode
                    ? error.message
                    : `Unable to generate the ${type}. Please try again.`,
            });
    }
};

const generateOrderLabel =
    generateOrderDocument('label');

const generateOrderManifest =
    generateOrderDocument('manifest');

const trackingText = value =>
    typeof value === 'string' ? value.trim() : '';

const trackingStatusId = value => {
    if (!['number', 'string'].includes(typeof value)) {
        return null;
    }

    const number = Number(value);

    return Number.isSafeInteger(number) && number > 0
        ? number
        : null;
};

const safeTrackingUrl = value => {
    try {
        if (!trackingText(value)) return null;

        const url = new URL(value.trim());

        return (
            url.protocol === 'https:' &&
            !url.username &&
            !url.password
        )
            ? url.href
            : null;
    } catch {
        return null;
    }
};

const orderTrackingHandler = isAdmin => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');

    try {
        const { orderId } = req.params;

        if (
            typeof orderId !== 'string' ||
            !/^[a-f\d]{24}$/i.test(orderId)
        ) {
            throw shippingError('Invalid order ID');
        }

        if (!isAdmin && !req.user?.id) {
            throw shippingError(
                'Please sign in to track your order',
                401
            );
        }

        const filter = {
            _id: orderId,
        };

        // Customers can access only their own orders.
        if (!isAdmin) {
            filter.user = req.user.id;
        }

        const order = await Order.findOne(filter)
            .select('status deliveredAt shipping')
            .lean();

        if (!order) {
            throw shippingError('Order not found', 404);
        }

        const shipping = order.shipping || {};

        const tracking = {
            awbCode:
                trackingText(shipping.awbCode) || null,

            courierName:
                trackingText(shipping.courierName) || null,

            shipmentStatus:
                trackingText(shipping.shipmentStatus) || null,

            shipmentStatusId:
                trackingStatusId(shipping.shipmentStatusId),

            trackingUrl:
                safeTrackingUrl(shipping.trackingUrl),

            estimatedDeliveryAt:
                shipping.estimatedDeliveryAt || null,

            deliveredAt:
                order.deliveredAt || null,

            events: Array.isArray(shipping.trackingEvents)
                ? shipping.trackingEvents.map(event => ({
                    date: event.date || null,
                    activity: trackingText(event.activity),
                    location: trackingText(event.location),
                    status: trackingText(event.status),
                }))
                : [],
        };

        const reply = (trackingAvailable, message) =>
            res.status(200).json({
                success: true,
                orderId: String(order._id),
                orderStatus: order.status,
                trackingAvailable,
                message,
                tracking,
            });

        if (!tracking.awbCode) {
            return reply(
                false,
                'A tracking number has not been assigned yet.'
            );
        }

        // Use the saved AWB belonging to this order.
        const result = await fetchShiprocketTracking(
            tracking.awbCode
        );

        if (!result.trackingAvailable) {
            return reply(
                false,
                'No fresh tracking updates are available yet.'
            );
        }

        const data = result.trackingData;

        const shipment = data.shipment_track.find(
            item =>
                trackingText(item.awb_code) ===
                tracking.awbCode
        );

        if (
            !shipment ||
            (
                shipping.shipmentId &&
                shipment.shipment_id != null &&
                Number(shipment.shipment_id) !==
                shipping.shipmentId
            ) ||
            (
                shipping.shiprocketOrderId &&
                shipment.order_id != null &&
                Number(shipment.order_id) !==
                shipping.shiprocketOrderId
            )
        ) {
            throw shippingError(
                'Tracking response does not match the saved shipment',
                502
            );
        }

        tracking.courierName =
            trackingText(shipment.courier_name) ||
            tracking.courierName;

        tracking.shipmentStatus =
            trackingText(shipment.current_status) ||
            tracking.shipmentStatus;

        tracking.shipmentStatusId =
            trackingStatusId(data.shipment_status) ??
            tracking.shipmentStatusId;

        tracking.trackingUrl =
            safeTrackingUrl(data.track_url) ||
            tracking.trackingUrl;

        tracking.estimatedDeliveryAt =
            parseShiprocketPickupDate(data.etd) ||
            parseShiprocketPickupDate(shipment.edd) ||
            tracking.estimatedDeliveryAt;

        if (tracking.shipmentStatusId === 7) {
            tracking.deliveredAt =
                parseShiprocketPickupDate(
                    shipment.delivered_date
                ) ||
                tracking.deliveredAt;
        }

        if (Array.isArray(data.shipment_track_activities)) {
            tracking.events = data.shipment_track_activities
                .filter(
                    event =>
                        event &&
                        typeof event === 'object'
                )
                .map(event => {
                    const label = trackingText(
                        event['sr-status-label']
                    );

                    return {
                        date: parseShiprocketPickupDate(
                            event.date
                        ),
                        activity: trackingText(event.activity),
                        location: trackingText(event.location),
                        status:
                            label && label !== 'NA'
                                ? label
                                : trackingText(event.status),
                    };
                })
                .filter(
                    event => event.activity || event.status
                )
                .sort(
                    (a, b) =>
                        (b.date?.getTime() || 0) -
                        (a.date?.getTime() || 0)
                );
        }

        return reply(
            true,
            'Tracking details fetched successfully.'
        );
    } catch (error) {
        console.error('orderTracking:', error.message);

        return res
            .status(error.statusCode || 502)
            .json({
                error: error.statusCode
                    ? error.message
                    : 'Unable to fetch tracking details. Please try again.',
            });
    }
};

const getMyOrderTracking = orderTrackingHandler(false);
const getAdminOrderTracking = orderTrackingHandler(true);

const webhookDate = value => {
    if (typeof value !== 'string') return null;

    // Shiprocket also sends: DD MM YYYY HH:mm:ss
    const match = value.trim().match(
        /^(\d{2})\s+(\d{2})\s+(\d{4})\s+(.+)$/
    );

    return parseShiprocketPickupDate(
        match
            ? `${match[3]}-${match[2]}-${match[1]} ${match[4]}`
            : value
    );
};

const receiveShippingEvent = async (req, res) => {
    res.set('Cache-Control', 'private, no-store');

    const secret = process.env.SHIPROCKET_WEBHOOK_TOKEN;

    if (!secret) {
        return res.status(503).json({
            error: 'Webhook is not configured',
        });
    }

    const supplied = req.get('x-api-key');

    const expectedBuffer = Buffer.from(secret);
    const suppliedBuffer = Buffer.from(
        typeof supplied === 'string' ? supplied : ''
    );

    if (
        expectedBuffer.length !== suppliedBuffer.length ||
        !crypto.timingSafeEqual(
            expectedBuffer,
            suppliedBuffer
        )
    ) {
        return res.status(401).json({
            error: 'Invalid webhook token',
        });
    }

    try {
        const body = req.body;

        if (
            !body ||
            typeof body !== 'object' ||
            Array.isArray(body)
        ) {
            throw shippingError('Invalid webhook body');
        }

        const acknowledge = reason =>
            res.status(200).json({
                success: true,
                received: true,
                result: reason,
            });

        if (!Object.keys(body).length) {
            return acknowledge('Empty test event');
        }

        // This handler covers the original outbound shipment.
        if ([1, '1', true].includes(body.is_return)) {
            return acknowledge('Return shipment ignored');
        }

        if (
            body.is_return !== undefined &&
            ![0, '0', false].includes(body.is_return)
        ) {
            throw shippingError('Invalid shipment direction');
        }

        const awb = trackingText(body.awb);
        const sourceOrderId = trackingText(body.order_id);
        const remoteOrderId = positiveNumber(body.sr_order_id);

        const statusId = trackingStatusId(
            body.shipment_status_id
        );

        const statusName =
            trackingText(body.shipment_status) ||
            trackingText(body.current_status);

        const eventAt = webhookDate(
            body.current_timestamp
        );

        if (
            !/^[a-z0-9-]{1,100}$/i.test(awb) ||
            !sourceOrderId ||
            sourceOrderId.length > 50 ||
            !Number.isSafeInteger(remoteOrderId) ||
            !statusId ||
            !statusName ||
            !eventAt ||
            (
                body.scans !== undefined &&
                !Array.isArray(body.scans)
            )
        ) {
            throw shippingError('Invalid tracking event fields');
        }

        const scans = body.scans || [];

        const events = scans
            .map(scan => {
                const label = trackingText(
                    scan?.['sr-status-label']
                );

                return {
                    date: webhookDate(scan?.date),
                    activity: trackingText(scan?.activity),
                    location: trackingText(scan?.location),
                    status:
                        label && label !== 'NA'
                            ? label
                            : trackingText(scan?.status),
                };
            })
            .filter(
                event =>
                    event.date &&
                    (event.activity || event.status)
            );

        let outcome;

        await Order.db.transaction(async session => {
            outcome = 'Ignored';

            // Saved before our external order-creation request.
            const order = await Order.findOne({
                'shipping.sourceOrderId': sourceOrderId,
            })
                .select('status deliveredAt shipping')
                .session(session)
                .lean();

            if (!order) {
                outcome = 'Unmatched order';
                return;
            }

            const shipping = order.shipping || {};

            if (
                (
                    shipping.shiprocketOrderId &&
                    shipping.shiprocketOrderId !== remoteOrderId
                ) ||
                (
                    shipping.awbCode &&
                    trackingText(shipping.awbCode) !== awb
                )
            ) {
                outcome = 'Shipment identity mismatch';
                return;
            }

            // Preserve delivery confirmation for this shipment.
            if (
                shipping.shipmentStatusId === 7 &&
                statusId !== 7
            ) {
                outcome = 'Delivered shipment preserved';
                return;
            }

            const previousAt = shipping.lastEventAt
                ? new Date(shipping.lastEventAt).getTime()
                : null;

            const incomingAt = eventAt.getTime();

            // Allow delivery confirmation within the same second.
            const deliveryTie =
                previousAt === incomingAt &&
                statusId === 7 &&
                shipping.shipmentStatusId !== 7;

            if (
                previousAt !== null &&
                (
                    incomingAt < previousAt ||
                    (
                        incomingAt === previousAt &&
                        !deliveryTie
                    )
                )
            ) {
                outcome = 'Duplicate or older event';
                return;
            }

            const merged = new Map();

            for (const event of [
                ...(shipping.trackingEvents || []),
                ...events,
            ]) {
                const date = event.date instanceof Date
                    ? event.date
                    : webhookDate(event.date);

                if (
                    !date ||
                    !Number.isFinite(date.getTime())
                ) {
                    continue;
                }

                const normalized = {
                    date,
                    activity: trackingText(event.activity),
                    location: trackingText(event.location),
                    status: trackingText(event.status),
                };

                const key = JSON.stringify([
                    date.toISOString(),
                    normalized.activity,
                    normalized.location,
                ]);

                merged.set(key, normalized);
            }

            const changes = {
                'shipping.shiprocketOrderId': remoteOrderId,
                'shipping.awbCode': awb,
                'shipping.shipmentStatus': statusName,
                'shipping.shipmentStatusId': statusId,
                'shipping.lastEventAt': eventAt,
                'shipping.lastSyncedAt': new Date(),

                'shipping.trackingEvents':
                    [...merged.values()].sort(
                        (a, b) =>
                            b.date.getTime() - a.date.getTime()
                    ),
            };

            const courier = trackingText(body.courier_name);

            if (courier) {
                changes['shipping.courierName'] = courier;
            }

            const estimatedDelivery = webhookDate(body.etd);

            if (estimatedDelivery) {
                changes['shipping.estimatedDeliveryAt'] =
                    estimatedDelivery;
            }

            if (!shipping.pickupRequestedAt) {
                const pickupDates = scans
                    .filter(
                        scan =>
                            [3, 4].includes(
                                trackingStatusId(
                                    scan?.['sr-status']
                                )
                            )
                    )
                    .map(scan => webhookDate(scan.date))
                    .filter(Boolean)
                    .sort(
                        (a, b) => a.getTime() - b.getTime()
                    );

                if (
                    pickupDates.length ||
                    [3, 4].includes(statusId)
                ) {
                    changes['shipping.pickupRequestedAt'] =
                        pickupDates[0] || eventAt;
                }
            }

            const scheduledPickup = webhookDate(
                body.pickup_scheduled_date
            );

            if (scheduledPickup) {
                changes['shipping.pickupScheduledAt'] =
                    scheduledPickup;
            }

            const trackingUrl = safeTrackingUrl(
                body.tracking_url
            );

            if (trackingUrl) {
                changes['shipping.trackingUrl'] = trackingUrl;
            }

            const dispatchStatuses = new Set([
                6, 17, 18, 38, 39, 42, 51,
            ]);

            const dispatched =
                dispatchStatuses.has(statusId) ||
                scans.some(
                    scan =>
                        dispatchStatuses.has(
                            trackingStatusId(
                                scan?.['sr-status']
                            )
                        )
                );

            if (
                !['Cancelled', 'Delivered'].includes(
                    order.status
                )
            ) {
                if (statusId === 7) {
                    changes.status = 'Delivered';
                } else if (dispatched) {
                    changes.status = 'Shipped';
                } else if (
                    order.status === 'Pending' &&
                    [1, 2, 3, 4, 5].includes(statusId)
                ) {
                    changes.status = 'Processing';
                }
            }

            if (
                statusId === 7 &&
                order.status !== 'Cancelled' &&
                !order.deliveredAt
            ) {
                const deliveryDates = scans
                    .filter(
                        scan =>
                            trackingStatusId(
                                scan?.['sr-status']
                            ) === 7
                    )
                    .map(scan => webhookDate(scan.date))
                    .filter(Boolean)
                    .sort(
                        (a, b) => a.getTime() - b.getTime()
                    );

                changes.deliveredAt =
                    deliveryDates[0] || eventAt;
            }

            await Order.updateOne(
                {
                    _id: order._id,
                },
                {
                    $set: changes,
                },
                {
                    session,
                    runValidators: true,
                }
            );

            outcome = 'Updated';
        });

        return acknowledge(outcome);
    } catch (error) {
        console.error(
            'receiveShippingEvent:',
            error.message
        );

        return res
            .status(error.statusCode || 503)
            .json({
                error: error.statusCode
                    ? error.message
                    : 'Unable to process shipping event',
            });
    }
};


const checkOrderAwbStatus = async (req, res) => {
    try {
        const { orderId } = req.params;

        if (!/^[a-f\d]{24}$/i.test(orderId || '')) {
            return res.status(400).json({
                error: 'Invalid order ID',
            });
        }

        const order = await Order.findById(orderId)
            .select('shipping')
            .lean();

        if (!order) {
            return res.status(404).json({
                error: 'Order not found',
            });
        }

        const shipmentId = order.shipping?.shipmentId;

        if (!shipmentId) {
            return res.status(409).json({
                error: 'No Shiprocket shipment exists',
            });
        }

        const remote = await getShiprocketShipmentDetails(
            shipmentId
        );

        if (
            Number(remote.shiprocketOrderId) !==
            Number(order.shipping.shiprocketOrderId)
        ) {
            return res.status(409).json({
                error: 'Shiprocket order ID mismatch. Manual review required.',
            });
        }

        console.log('AWB reconciliation check:', {
            orderId: String(order._id),
            bookingStatus: order.shipping.bookingStatus,
            hasRemoteAwb: Boolean(remote.awbCode),
            hasLocalAwb: Boolean(order.shipping.awbCode),
        });

        return res.status(200).json({
            success: true,
            awbAssigned: Boolean(remote.awbCode),
            remote,
            bookingStatus: order.shipping.bookingStatus,
            message: remote.awbCode
                ? 'An AWB already exists in Shiprocket.'
                : 'No AWB currently appears in Shiprocket.',
        });
    } catch (error) {
        console.error(
            'checkOrderAwbStatus:',
            error.message
        );

        return res.status(502).json({
            error: 'Unable to verify shipment status with Shiprocket',
        });
    }
};

const resolveOrderAwbIssue = async (req, res) => {
    try {
        const { orderId } = req.params;

        if (!/^[a-f\d]{24}$/i.test(orderId || '')) {
            return res.status(400).json({
                error: 'Invalid order ID',
            });
        }

        const order = await Order.findById(orderId)
            .select('shipping status updatedAt')
            .lean();

        if (!order) {
            return res.status(404).json({
                error: 'Order not found',
            });
        }

        const shipping = order.shipping || {};

        if (
            shipping.bookingStatus !== 'NeedsReview' ||
            shipping.lastOperation !== 'AssignAWB' ||
            shipping.awbCode ||
            !shipping.shipmentId
        ) {
            return res.status(409).json({
                error: 'This shipment is not eligible for AWB recovery',
            });
        }

        const remote = await getShiprocketShipmentDetails(
            shipping.shipmentId
        );

        if (
            Number(remote.shipmentId) !== Number(shipping.shipmentId) ||
            Number(remote.shiprocketOrderId) !==
            Number(shipping.shiprocketOrderId)
        ) {
            return res.status(409).json({
                error: 'Shiprocket shipment IDs do not match',
            });
        }

        if (
            remote.awbCode ||
            remote.courierId ||
            Number(remote.shipmentStatus) !== 11
        ) {
            return res.status(409).json({
                error: 'Remote shipment requires review before retrying',
            });
        }

        // Explicit admin recovery, not an automatic retry.
        const updated = await Order.findOneAndUpdate(
            {
                _id: order._id,
                updatedAt: order.updatedAt,
                'shipping.bookingStatus': 'NeedsReview',
                'shipping.lastOperation': 'AssignAWB',
                'shipping.shipmentId': shipping.shipmentId,
                $or: [
                    { 'shipping.awbCode': { $exists: false } },
                    { 'shipping.awbCode': null },
                    { 'shipping.awbCode': '' },
                ],
            },
            {
                $set: {
                    'shipping.bookingStatus': 'Created',
                    'shipping.lastError': '',
                    'shipping.lastOperation': 'ResolveAWB',
                },
            },
            {
                new: true,
                runValidators: true,
            }
        );

        if (!updated) {
            return res.status(409).json({
                error: 'Order changed. Refresh and try again.',
            });
        }

        console.log('AWB recovery completed:', {
            orderId,
            shipmentId: shipping.shipmentId,
            previousStatus: 'NeedsReview',
            newStatus: updated.shipping.bookingStatus,
        });

        return res.status(200).json({
            success: true,
            message: 'Shipment unlocked for AWB assignment',
            shipping: updated.shipping,
        });

    } catch (error) {
        console.error('resolveOrderAwbIssue:', error.message);

        return res.status(502).json({
            error: 'Unable to verify and recover the shipment',
        });
    }
};

const cancelOrderShipment = async (req, res) => {
    try {
        const { orderId } = req.params;

        if (!/^[a-f\d]{24}$/i.test(orderId || '')) {
            return res.status(400).json({
                error: 'Invalid order ID',
            });
        }

        const order = await Order.findById(orderId)
            .select('shipping')
            .lean();

        if (!order) {
            return res.status(404).json({
                error: 'Order not found',
            });
        }

        const shipping = order.shipping || {};

        if (!shipping.awbCode) {
            return res.status(409).json({
                error: 'No AWB assigned to this shipment',
            });
        }

        const result = await cancelShiprocketShipment(shipping.awbCode);

        console.log('SHIPROCKET CANCELLATION RESULT:', result);

        return res.status(200).json({
            success: true,
            message: 'Cancellation request sent to Shiprocket',
            cancellation: result,
        });
    } catch (error) {
        console.error('cancelOrderShipment:', error.message);

        return res.status(502).json({
            error: 'Unable to request shipment cancellation',
        });
    }
};

module.exports = {
    getOrderShippingRates, createOrderShipment, assignOrderAwb, requestOrderPickup, generateOrderLabel,
    generateOrderManifest, getMyOrderTracking, getAdminOrderTracking, receiveShippingEvent, checkOrderAwbStatus,
    resolveOrderAwbIssue, cancelOrderShipment
};