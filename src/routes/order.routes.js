const express = require('express');
const { placeOrder, getMyOrders, cancelOrder, requestReturn, requestExchange } = require('../controllers/order.controller');
const { requireAuth } = require('../middleware/auth.middleware');

const orderRouter = express.Router();

orderRouter.post('/place', requireAuth, placeOrder);
orderRouter.get('/my-orders', requireAuth, getMyOrders);
orderRouter.post('/:orderId/cancel', requireAuth, cancelOrder);

orderRouter.post('/:orderId/return-request', requireAuth, requestReturn);

orderRouter.post('/:orderId/exchange-request', requireAuth, requestExchange);

module.exports = orderRouter;