const mongoose = require('mongoose');

const addressSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    addressLine1: { type: String, required: true },
    addressLine2: { type: String, default: null }, // Optional
    area: { type: String, required: true },
    city: { type: String, required: true },
    dist: { type: String, required: true }, // District
    state: { type: String, required: true },
    pincode: { type: String, required: true },
    phone: { type: String, required: true },
    addressType: { 
        type: String, 
        enum: ['Home', 'Work', 'Other'], 
        default: 'Home',
        required: true 
    },
    isDefault: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('Address', addressSchema);