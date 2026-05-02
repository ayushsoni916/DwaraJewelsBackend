// routes/collection.routes.js
const express = require('express');
const collectionRouter = express.Router();
const multer = require('multer');
const { createCollection, getCollections } = require('../controllers/collection.controller');

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

collectionRouter.post('/', upload.single('image'), createCollection);
collectionRouter.get('/', getCollections);

module.exports = collectionRouter;