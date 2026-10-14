const express = require('express');
const multer = require('multer');

const upload = multer({
    storage: multer.memoryStorage(),
});

const { getAllUsers } = require("./user.routes");
const { updateOrderStatus, getAdminOrderDetails, getAllOrders } = require('../controllers/adminOrder.controller');
const { getAdminCoupons, createAdminCoupon, updateAdminCoupon, deleteAdminCoupon } = require('../controllers/adminCoupon.controller');
const { getAdminProducts, getAdminProduct, createProduct, updateAdminProduct, setProductActive } = require('../controllers/product.controller');
const { getOrderShippingRates, createOrderShipment } = require('../controllers/shipping.controller');

const adminRouter = express.Router();


adminRouter.get('/users', getAllUsers);

adminRouter.get('/orders', getAllOrders);

adminRouter.get('/orders/:orderId', getAdminOrderDetails);

adminRouter.put('/orders/:orderId/status', updateOrderStatus);

adminRouter.post('/orders/:orderId/shipping/rates', getOrderShippingRates);
adminRouter.post('/orders/:orderId/shipping/create', createOrderShipment);

adminRouter.get('/coupons', getAdminCoupons);
adminRouter.post('/coupons', createAdminCoupon);
adminRouter.put('/coupons/:couponId', updateAdminCoupon);
adminRouter.delete('/coupons/:couponId', deleteAdminCoupon);

// products
adminRouter.get('/products', getAdminProducts);
adminRouter.get('/products/:productId', getAdminProduct);

adminRouter.post('/products', upload.array('images'), createProduct);

adminRouter.put(
    '/products/:productId',
    upload.array('images'),
    updateAdminProduct
);

adminRouter.put('/products/:productId/status', setProductActive);

module.exports = adminRouter;