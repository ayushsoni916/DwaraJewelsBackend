const express = require('express');
const { placeOrder, getMyOrders } = require('../controllers/order.controller');
const { requireAuth } = require('../middleware/auth.middleware');

const orderRouter = express.Router();

orderRouter.post('/place', requireAuth, placeOrder);
orderRouter.get('/my-orders', requireAuth, getMyOrders);

module.exports = orderRouter;