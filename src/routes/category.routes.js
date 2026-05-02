const express = require('express');
const multer = require('multer');
const { getAllCategories, createCategory, updateCategory, deleteCategory } = require('../controllers/category.controller');

const categoryRouter = express.Router();

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Public Routes
categoryRouter.get('/', getAllCategories); // Fetch tabs (Earrings, Rings, etc.)

// Admin Routes
// Note: Add middleware here later to protect these
categoryRouter.post('/', upload.single('image'), createCategory);
categoryRouter.put('/:id', updateCategory);
categoryRouter.delete('/:id', deleteCategory);

module.exports = categoryRouter;