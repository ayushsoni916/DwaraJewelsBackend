const express = require('express');
const { addToCart, getCart, updateCartItem, removeCartItem, applyCoupon, createCoupon, getAllCoupons } = require('../controllers/cart.controller');
const cartRouter = express.Router();

cartRouter.post('/add', addToCart)
cartRouter.get('/get', getCart)
cartRouter.put('/update-item', updateCartItem)
cartRouter.delete('/remove-item/:itemId', removeCartItem)
cartRouter.post('/apply-coupon', applyCoupon)
cartRouter.post('/coupon/create', createCoupon); // Ideally protect this with an isAdmin middleware later
cartRouter.get('/coupons/all', getAllCoupons);

module.exports = cartRouter;