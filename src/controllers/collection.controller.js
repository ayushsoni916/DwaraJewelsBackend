// controllers/collection.controller.js
const collectionModel = require("../models/collection.model");
const cloudinary = require("../config/cloudinary");

// --- Create Collection ---
exports.createCollection = async (req, res) => {
    try {
        const { name } = req.body;
        const file = req.file;

        if (!name) return res.status(400).json({ error: "Collection name is required" });
        if (!file) return res.status(400).json({ error: "Collection image is required" });

        // Check if name already exists
        const existing = await collectionModel.findOne({ name });
        if (existing) return res.status(400).json({ error: "Collection already exists" });

        // Upload to Cloudinary
        const uploadedImage = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
                { folder: "dwara_collections" },
                (err, result) => {
                    if (err) reject(err);
                    else resolve({ url: result.secure_url, publicId: result.public_id });
                }
            );
            stream.end(file.buffer);
        });

        const collection = await collectionModel.create({
            name,
            image: uploadedImage
        });

        res.status(201).json({ success: true, message: "Collection created", collection });
    } catch (error) {
        console.error("createCollection error", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

// --- Get All Collections ---
exports.getCollections = async (req, res) => {
    try {
        const collections = await collectionModel.find().sort({ createdAt: -1 });
        res.status(200).json({ success: true, count: collections.length, collections });
    } catch (error) {
        res.status(500).json({ error: "Internal server error" });
    }
};

const updateCollection = async (req, res) => {
    let uploadedImage;
    let saved = false;

    try {
        const { id } = req.params;

        if (!/^[a-f\d]{24}$/i.test(id || '')) {
            return res.status(400).json({
                error: 'Invalid collection ID',
            });
        }

        const name = req.body?.name;

        if (typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({
                error: 'Collection name is required',
            });
        }

        const collection = await collectionModel.findById(id);

        if (!collection) {
            return res.status(404).json({
                error: 'Collection not found',
            });
        }

        collection.name = name.trim();

        await collection.validate();

        if (req.file) {
            if (
                !req.file.mimetype?.startsWith('image/') ||
                !req.file.buffer
            ) {
                return res.status(400).json({
                    error: 'Upload a valid image',
                });
            }

            const result = await new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    {
                        folder: 'dwara_collections',
                        resource_type: 'image',
                    },
                    (error, result) =>
                        error ? reject(error) : resolve(result)
                );

                stream.end(req.file.buffer);
            });

            uploadedImage = {
                url: result.secure_url,
                publicId: result.public_id,
            };

            collection.image = uploadedImage;
        }

        await collection.save();
        saved = true;

        return res.json({
            success: true,
            message: 'Collection updated',
            collection,
        });
    } catch (error) {
        if (uploadedImage && !saved) {
            await cloudinary.uploader
                .destroy(uploadedImage.publicId)
                .catch(() => {});
        }

        console.error('updateCollection error:', error);

        const validationError =
            error.name === 'ValidationError' ||
            error.name === 'CastError';

        return res.status(
            error.code === 11000
                ? 409
                : validationError
                    ? 400
                    : 500
        ).json({
            error: error.code === 11000
                ? 'Collection name already exists'
                : validationError
                    ? error.message
                    : 'Unable to update collection',
        });
    }
};

module.exports.updateCollection = updateCollection;