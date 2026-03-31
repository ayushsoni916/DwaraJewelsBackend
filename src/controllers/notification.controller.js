const notificationModel = require("../models/notification.model");

// 1. Get all notifications for the logged-in user
exports.getNotifications = async (req, res) => {
    try {
        const userId = req?.user?.id;

        // Find notifications for this specific user OR global ones (null)
        const notifications = await notificationModel.find({
            $or: [
                { targetUser: userId },
                { targetUser: null }
            ]
        }).sort({ createdAt: -1 }); // Newest first

        res.status(200).json({
            success: true,
            notifications
        });
    } catch (error) {
        console.error("getNotifications error", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

// 2. Create a notification (Admin trigger)
exports.createNotification = async (req, res) => {
    try {
        const { title, description, targetUser } = req.body;

        const notification = await notificationModel.create({
            title,
            description,
            targetUser: targetUser || null
        });

        res.status(201).json({
            success: true,
            notification
        });
    } catch (error) {
        res.status(500).json({ error: "Failed to create notification" });
    }
};