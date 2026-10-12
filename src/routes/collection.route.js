// routes/collection.routes.js
const express = require('express');
const collectionRouter = express.Router();
const multer = require('multer');
const { createCollection, getCollections, updateCollection } = require('../controllers/collection.controller');

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

collectionRouter.post('/', upload.single('image'), createCollection);
collectionRouter.get('/', getCollections);
collectionRouter.put(
    '/:id',
    upload.single('image'),
    updateCollection
);

module.exports = collectionRouter;