// 1. Create Category (Admin Only)

const categoryModel = require("../models/category.model");
const cloudinary = require("../config/cloudinary");

// Use this to populate "Earrings", "Rings", etc.
const createCategory = async (req, res) => {
    try {
        const { name, subCategories, isFeatured, isLuxeCategory } = req.body;
        const file = req.file;

        if (!name) {
            return res.status(400).json({ error: "Category name is required" });
        }

        if (!file) return res.status(400).json({ error: "Category image is required" });

        // 1. Normalize the luxe flag (Old categories without this var are treated as false)
        const luxeStatus = isLuxeCategory || false;

        // 2. Check for existence based on BOTH name and Luxe status
        // This allows 'Ring' (false) and 'Ring' (true) to coexist.
        const existing = await categoryModel.findOne({
            name: name,
            isLuxeCategory: luxeStatus
        });

        if (existing) {
            return res.status(400).json({
                error: `Category '${name}' already exists in ${luxeStatus ? 'Luxe' : 'Standard'} collection`
            });
        }

        // --- Cloudinary Upload Logic ---
        const uploadedImage = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
                { folder: "dwara_categories" },
                (err, result) => {
                    if (err) reject(err);
                    else resolve({ url: result.secure_url, publicId: result.public_id });
                }
            );
            stream.end(file.buffer);
        });

        // / Parse subCategories if they come as a string (common with FormData)
        const parsedSubs = typeof subCategories === 'string'
            ? subCategories.split(',').map(s => s.trim())
            : subCategories;

        const category = await categoryModel.create({
            name,
            image: uploadedImage, // Now contains { url, publicId }
            subCategories: parsedSubs || [],
            isFeatured: isFeatured === 'true' || isFeatured === true,
            isLuxeCategory: luxeStatus
        });

        return res.status(201).json({
            success: true,
            message: "Category created successfully",
            category
        });

    } catch (error) {
        console.error("createCategory error", error);
        return res.status(500).json({ error: "Internal server error" });
    }
};

// 2. Get All Categories (For the Top Tabs UI)
// You can use ?featured=true to get only categories meant for the Home Page
const getAllCategories = async (req, res) => {
    try {
        const { featured, type } = req.query;

        const query = {};
        if (featured === 'true') {
            query.isFeatured = true;
        }

        // 2. Handle Luxe vs Normal Filter
        if (type === 'luxury') {
            query.isLuxeCategory = true;
        } else if (type === 'normal') {
            // This query fetches both explicit 'false' and documents missing the field
            query.isLuxeCategory = { $ne: true };
        }

        const categories = await categoryModel.find(query)
            .select("name image subCategories isFeatured isLuxeCategory") // Select only what UI needs
            .lean();

        return res.json({
            success: true,
            count: categories.length,
            categories
        });
    } catch (error) {
        console.error("getAllCategories error", error);
        return res.status(500).json({ error: "Internal server error" });
    }
}

// 3. Update Category (Admin - e.g., adding a new subCategory like "Jhumkas")
const updateCategory = async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        const category = await categoryModel.findByIdAndUpdate(
            id,
            updates,
            { new: true } // Return the updated document
        );

        if (!category) {
            return res.status(404).json({ error: "Category not found" });
        }

        return res.json({
            success: true,
            message: "Category updated",
            category
        });

    } catch (error) {
        console.error("updateCategory error", error);
        return res.status(500).json({ error: "Internal server error" });
    }
}

// 4. Delete Category
const deleteCategory = async (req, res) => {
    try {
        const { id } = req.params;

        const category = await categoryModel.findByIdAndDelete(id);

        if (!category) {
            return res.status(404).json({ error: "Category not found" });
        }

        return res.json({
            success: true,
            message: "Category deleted successfully"
        });
    } catch (error) {
        console.error("deleteCategory error", error);
        return res.status(500).json({ error: "Internal server error" });
    }
}

module.exports = {
    createCategory,
    getAllCategories,
    updateCategory,
    deleteCategory
};