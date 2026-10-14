const mongoose = require('mongoose');

const positiveMeasurement = () => ({
    type: Number,
    validate: {
        validator: value => Number.isFinite(value) && value > 0,
        message: 'Package measurements must be greater than zero',
    },
});

const shipmentSchema = new mongoose.Schema({
    sourceOrderId: { type: String, trim: true },
    shiprocketOrderId: { type: Number, min: 1 },
    shipmentId: { type: Number, min: 1 },

    awbCode: { type: String, trim: true },
    courierId: { type: Number },
    courierName: { type: String },
    pickupLocation: { type: String },

    bookingStatus: {
        type: String,
        enum: [
            'NotCreated',
            'Creating',
            'Created',
            'NeedsReview',
            'Failed',
        ],
        default: 'NotCreated',
    },
    bookingStartedAt: { type: Date },
    lastOperation: { type: String },
    lastError: { type: String, maxlength: 1000 },

    // Packed parcel measurements.
    packageDetails: {
        weightKg: positiveMeasurement(),
        lengthCm: positiveMeasurement(),
        breadthCm: positiveMeasurement(),
        heightCm: positiveMeasurement(),
    },

    pickupRequestedAt: { type: Date },
    pickupScheduledAt: { type: Date },

    labelUrl: { type: String },
    manifestUrl: { type: String },
    trackingUrl: { type: String },

    shipmentStatus: { type: String },
    shipmentStatusId: { type: Number },
    estimatedDeliveryAt: { type: Date },
    lastEventAt: { type: Date },
    lastSyncedAt: { type: Date },

    trackingEvents: [{
        date: Date,
        activity: String,
        location: String,
        status: String,
        _id: false,
    }],
}, { _id: false });

const orderSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },

    items: [{
        product: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Product',
            required: true,
        },
        dimensionId: {
            type: mongoose.Schema.Types.ObjectId,
        },
        quantity: {
            type: Number,
            required: true,
            min: 1,
            validate: {
                validator: Number.isSafeInteger,
                message: 'Quantity must be a whole number',
            },
        },
        size: {
            type: String,
        },
        priceAtPurchase: {
            type: Number,
            required: true,
            min: 0,
        },
    }],
    deliveredAt: {
        type: Date,
    },

    // Address snapshot at the time of purchase.
    shippingAddress: {
        type: Object,
        required: true,
    },

    shipping: {
        type: shipmentSchema,
        default: () => ({}),
    },

    summary: {
        subtotal: Number,
        discount: Number,
        shipping: Number,
        totalCost: Number,
    },

    status: {
        type: String,
        enum: [
            'Pending',
            'Processing',
            'Shipped',
            'Delivered',
            'Cancelled',
        ],
        default: 'Pending',
    },

    cancelledAt: {
        type: Date,
    },
    cancellationReason: {
        type: String,
        trim: true,
        maxlength: 500,
    },

    // Item-level return and exchange requests.
    serviceRequests: [{
        itemId: {
            type: mongoose.Schema.Types.ObjectId,
            required: true,
        },
        type: {
            type: String,
            enum: ['Return', 'Exchange'],
            required: true,
        },
        quantity: {
            type: Number,
            required: true,
            min: 1,
            validate: {
                validator: Number.isSafeInteger,
                message: 'Quantity must be a whole number',
            },
        },
        reason: {
            type: String,
            required: true,
            trim: true,
            maxlength: 500,
        },

        // Replacement dimension for an exchange.
        targetDimensionId: {
            type: mongoose.Schema.Types.ObjectId,
        },
        targetDimensions: {
            size: String,
            width: String,
            length: String,
        },
        // Customer → warehouse.
        returnShipment: {
            type: shipmentSchema,
        },

        // Exchange replacement: warehouse → customer.
        replacementShipment: {
            type: shipmentSchema,
        },

        status: {
            type: String,
            enum: [
                'Requested',
                'Approved',
                'Rejected',
                'Completed',
            ],
            default: 'Requested',
        },
        requestedAt: {
            type: Date,
            default: Date.now,
        },
        reviewedAt: {
            type: Date,
        },
        completedAt: {
            type: Date,
        },
        adminNote: {
            type: String,
            trim: true,
        },
    }],

    paymentType: {
        type: String,
        enum: ['Online', 'COD'],
    },
    paymentStatus: {
        type: String,
        default: 'Pending',
    },

    orderDate: {
        type: Date,
        default: Date.now,
    },
}, {
    timestamps: true,
});

orderSchema.index(
    { 'shipping.shipmentId': 1 },
    {
        unique: true,
        partialFilterExpression: {
            'shipping.shipmentId': { $type: 'number' },
        },
    }
);

orderSchema.index({ 'shipping.awbCode': 1 });

orderSchema.index({
    'serviceRequests.returnShipment.awbCode': 1,
});

orderSchema.index({
    'serviceRequests.replacementShipment.awbCode': 1,
});

module.exports = mongoose.model('Order', orderSchema);