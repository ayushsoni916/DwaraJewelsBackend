const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
    title: { 
        type: String, 
        required: true 
    },
    description: { 
        type: String, 
        required: true 
    },
    // If null, it's a global notification. If ID exists, it's private.
    targetUser: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User', 
        default: null 
    }
}, { 
    timestamps: true // This provides 'createdAt' and 'updatedAt' automatically
});

module.exports = mongoose.model('Notification', notificationSchema);