const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { getNotifications, createNotification } = require('../controllers/notification.controller');

const notificationRouter = express.Router();

// Get list
notificationRouter.get('/', requireAuth, getNotifications);

// Create new (Internal/Admin)
notificationRouter.post('/create', createNotification);

module.exports = notificationRouter;