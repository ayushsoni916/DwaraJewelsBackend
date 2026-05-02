const express = require('express');
const multer = require('multer');
const { getProducts, getProductDetails, getSimilarProducts, createProduct } = require('../controllers/product.controller');
const { optionalAuth } = require('../middleware/auth.middleware');

const productRouter = express.Router();
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Public Routes (Browsing)
productRouter.get('/', optionalAuth, getProducts);                    // Home/Filter feed
productRouter.get('/:id', optionalAuth, getProductDetails);           // Single Product Inner Page
productRouter.get('/:id/similar', optionalAuth, getSimilarProducts);  // "Similar Products" Logic

// Admin Routes (Management)
// Note: In a real app, add middleware like verifyAdmin here
productRouter.post('/', upload.array('images', 10), createProduct);

module.exports = productRouter;