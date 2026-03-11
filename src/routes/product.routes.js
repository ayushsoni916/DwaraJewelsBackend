const express = require('express');
const { getProducts, getProductDetails, getSimilarProducts, createProduct } = require('../controllers/product.controller');

const productRouter = express.Router();

// Public Routes (Browsing)
productRouter.get('/', getProducts);                    // Home/Filter feed
productRouter.get('/:id', getProductDetails);           // Single Product Inner Page
productRouter.get('/:id/similar', getSimilarProducts);  // "Similar Products" Logic

// Admin Routes (Management)
// Note: In a real app, add middleware like verifyAdmin here
productRouter.post('/', createProduct); 

module.exports = productRouter;