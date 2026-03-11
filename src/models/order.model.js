const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    items: [{
        product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
        quantity: { type: Number, required: true },
        size: { type: String },
        priceAtPurchase: { type: Number, required: true } // Important: Store price at time of order
    }],
    shippingAddress: { type: Object, required: true }, // Store snapshot of address
    summary: {
        subtotal: Number,
        discount: Number,
        shipping: Number,
        totalCost: Number
    },
    status: { 
        type: String, 
        enum: ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled'], 
        default: 'Pending' 
    },
    paymentStatus: { type: String, default: 'Pending' },
    orderDate: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('Order', orderSchema);