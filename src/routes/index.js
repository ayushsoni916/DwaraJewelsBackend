const express = require('express');
const authRouter = require('./auth.routes');
const { requireAuth } = require('../middleware/auth.middleware');
const bannerRouter = require('./banner.routes');
const productRouter = require('./product.routes');
const categoryRouter = require('./category.routes');
const cartRouter = require('./cart.routes');
const addressRouter = require('./address.routes');
const orderRouter = require('./order.routes');
const wishlistRouter = require('./wishlist.routes');
const notificationRouter = require('./notification.routes');
const collectionRouter = require('./collection.route');
const router = express.Router();

router.use('/auth', authRouter)
router.use('/banners', bannerRouter);
router.use('/product',productRouter)
router.use('/category',categoryRouter)
router.use('/cart', requireAuth, cartRouter)
router.use('/address', requireAuth, addressRouter);
router.use('/orders', requireAuth, orderRouter);
router.use('/wishlist', requireAuth, wishlistRouter);
router.use('/notifications', notificationRouter);
router.use('/collection', collectionRouter);
module.exports = router;