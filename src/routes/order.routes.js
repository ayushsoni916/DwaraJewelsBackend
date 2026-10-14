const express = require('express');
const { createOrder, getMyOrders, cancelOrder, requestReturn, requestExchange } = require('../controllers/order.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { getMyOrderTracking } = require('../controllers/shipping.controller');
const { getCheckoutStatus, } = require('../controllers/payment.controller');

const orderRouter = express.Router();

// orderRouter.post('/place', requireAuth, placeOrder);
orderRouter.post('/create', requireAuth, createOrder);
orderRouter.get('/my-orders', requireAuth, getMyOrders);
orderRouter.post('/:orderId/cancel', requireAuth, cancelOrder);

orderRouter.post('/:orderId/return-request', requireAuth, requestReturn);

orderRouter.post('/:orderId/exchange-request', requireAuth, requestExchange);
orderRouter.get('/:orderId/tracking', requireAuth, getMyOrderTracking);

orderRouter.get('/checkout/:checkoutId/status', requireAuth, getCheckoutStatus);


module.exports = orderRouter;