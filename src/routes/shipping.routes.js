const express = require('express');

const {
    receiveShippingEvent,
} = require('../controllers/shipping.controller');

const shippingRouter = express.Router();

shippingRouter.post(
    '/events',
    express.json({ limit: '256kb' }),
    receiveShippingEvent
);

module.exports = shippingRouter;