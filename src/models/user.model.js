const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    phone: {
        type: String,
        required: true,
        unique: true,
        index: true,
        trim: true
    },
    firstName: {
        type: String,
        trim: true,
        default: ''
    },
    lastName: {
        type: String,
        trim: true,
        default: ''
    },
    email: {
        type: String,
        lowercase: true,
        trim: true,
        index: true,
        sparse: true      // makes index ignore null values
    },
    gender: {
        type: String,
        enum: ['Male', 'Female', 'Other'],
        default: 'Male',
    },

}, {
    timestamps: true,
    versionKey: false
});

const User = mongoose.model("User", userSchema)

module.exports = User