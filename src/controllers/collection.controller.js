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