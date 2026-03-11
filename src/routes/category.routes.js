const express = require('express');
const { getAllCategories, createCategory, updateCategory, deleteCategory } = require('../controllers/category.controller');

const categoryRouter = express.Router();

// Public Routes
categoryRouter.get('/', getAllCategories); // Fetch tabs (Earrings, Rings, etc.)

// Admin Routes
// Note: Add middleware here later to protect these
categoryRouter.post('/', createCategory);
categoryRouter.put('/:id', updateCategory);
categoryRouter.delete('/:id', deleteCategory);

module.exports = categoryRouter;