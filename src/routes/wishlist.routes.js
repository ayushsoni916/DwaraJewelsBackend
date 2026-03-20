const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { getWishlist, toggleWishlist, moveToCart } = require('../controllers/wishlist.controller');

const wishlistRouter = express.Router();

wishlistRouter.get('/', requireAuth, getWishlist);
wishlistRouter.post('/toggle', requireAuth, toggleWishlist);
wishlistRouter.post('/move-to-cart', requireAuth, moveToCart);

module.exports = wishlistRouter;