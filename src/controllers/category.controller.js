// 1. Create Category (Admin Only)

const categoryModel = require("../models/category.model");

// Use this to populate "Earrings", "Rings", etc.
const createCategory = async (req, res) => {
    try {
        const { name, image, subCategories, isFeatured } = req.body;

        if (!name) {
            return res.status(400).json({ error: "Category name is required" });
        }

        const existing = await categoryModel.findOne({ name });
        if (existing) {
            return res.status(400).json({ error: "Category already exists" });
        }

        const category = await categoryModel.create({
            name,
            image: image || "",
            // Ensure subCategories is an array if provided, else empty array
            subCategories: subCategories || [],
            isFeatured: isFeatured || false
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
        const { featured } = req.query;

        const query = {};
        if (featured === 'true') {
            query.isFeatured = true;
        }

        const categories = await categoryModel.find(query)
            .select("name image subCategories isFeatured") // Select only what UI needs
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