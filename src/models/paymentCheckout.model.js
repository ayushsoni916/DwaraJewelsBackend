const mongoose = require('mongoose');

const paymentCheckoutSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },

    // Identifies the cart used when this checkout was created.
    cartId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Cart',
        required: true,
    },
    cartSignature: {
        type: String,
        required: true,
    },

    // Prevents repeated requests from creating multiple payment checkouts.
    requestId: {
        type: String,
        required: true,
    },

    // Snapshot: never rebuild the paid order from the current cart.
    items: [{
        product: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Product',
            required: true,
        },
        dimensionId: {
            type: mongoose.Schema.Types.ObjectId,
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
        size: String,
        priceAtPurchase: {
            type: Number,
            required: true,
            min: 0,
        },
    }],

    shippingAddress: {
        type: mongoose.Schema.Types.Mixed,
        required: true,
    },

    summary: {
        subtotal: { type: Number, required: true, min: 0 },
        discount: { type: Number, required: true, min: 0 },
        shipping: { type: Number, required: true, min: 0 },
        totalCost: { type: Number, required: true, min: 0 },
    },
    couponCode: {
        type: String,
        default: '',
    },

    // Razorpay amounts are stored in paise.
    amountPaise: {
        type: Number,
        required: true,
        min: 100,
        validate: {
            validator: Number.isSafeInteger,
            message: 'Payment amount must be a whole number of paise',
        },
    },
    currency: {
        type: String,
        enum: ['INR'],
        default: 'INR',
        required: true,
    },
    mode: {
        type: String,
        enum: ['Test', 'Live'],
        required: true,
    },

    // Public key ID associated with this checkout.
    keyId: {
        type: String,
        required: true,
    },

    razorpayOrderId: String,
    razorpayPaymentId: String,

    status: {
        type: String,
        enum: [
            'Creating',
            'AwaitingPayment',
            'CreationNeedsReview',
            'OrderPlaced',
            'PaidNeedsReview',
        ],
        default: 'Creating',
    },

    order: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Order',
    },
    paidAt: Date,
    lastError: {
        type: String,
        maxlength: 1000,
    },
}, {
    timestamps: true,
});

paymentCheckoutSchema.index(
    { user: 1, requestId: 1 },
    { unique: true }
);

paymentCheckoutSchema.index(
    { razorpayOrderId: 1 },
    { unique: true, sparse: true }
);

paymentCheckoutSchema.index(
    { razorpayPaymentId: 1 },
    { unique: true, sparse: true }
);

module.exports = mongoose.model(
    'PaymentCheckout',
    paymentCheckoutSchema
);