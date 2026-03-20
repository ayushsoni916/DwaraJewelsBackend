const productModel = require("../models/product.model");

// 1. Create Product (Admin side - required to populate the DB)
const createProduct = async (req, res) => {
    try {
        const {
            title,
            sku,
            description,
            category, // This should be a Category ID
            subCategory,
            collection,
            price, // Object: { basePrice, makingCharges, tax, finalPrice }
            metal, // Object: { type, quality, color, weight }
            stones, // Array of objects
            dimensions,
            images,
            thumbnail,
            tags,
            isNewArrival,
            isLuxe
        } = req.body;

        // Basic validation
        if (!title || !sku || !price || !price.finalPrice || !category) {
            return res.status(400).json({ error: "Title, SKU, Price, and Category are required" });
        }

        // Check if SKU already exists
        const existingProduct = await productModel.findOne({ sku });
        if (existingProduct) {
            return res.status(400).json({ error: "Product with this SKU already exists" });
        }

        const product = await productModel.create({
            title,
            sku,
            description,
            category,
            subCategory,
            collection,
            price,
            metal,
            stones,
            dimensions,
            images,
            thumbnail,
            tags,
            isNewArrival,
            isLuxe: isLuxe || false
        });

        return res.status(201).json({
            success: true,
            message: "Product created successfully",
            product
        });


    } catch (error) {
        console.error("createProduct error", error);
        return res.status(500).json({ error: "Internal server error" });
    }
}

// 2. Get All Products (For Home Page & Category Listing)
// Supports filters: ?category=ID & ?minPrice=100 & ?maxPrice=500 & ?sort=newest
const getProducts = async (req, res) => {
    try {
        const { category, subCategory, minPrice, maxPrice, sort, search, luxe } = req.query;

        // Build dynamic query object
        let query = {};

        if (category) {
            query.category = category;
        }

        if (subCategory) {
            query.subCategory = subCategory;
        }

        // --- Luxe Filter Logic ---
        if (luxe === 'true') {
            query.isLuxe = true;
        } else if (luxe === 'false') {
            // Fetches products where isLuxe is false OR the field is missing (legacy data)
            query.isLuxe = { $ne: true };
        }

        if (minPrice || maxPrice) {
            query["price.finalPrice"] = {};
            if (minPrice) query["price.finalPrice"].$gte = Number(minPrice);
            if (maxPrice) query["price.finalPrice"].$lte = Number(maxPrice);
        }

        if (search) {
            // requires text index in schema: productSchema.index({ title: 'text', tags: 'text' });
            query.$text = { $search: search };
        }

        // Handle Sorting
        let sortOption = {};
        if (sort === "price_low_high") sortOption = { "price.finalPrice": 1 };
        else if (sort === "price_high_low") sortOption = { "price.finalPrice": -1 };
        else if (sort === "newest") sortOption = { createdAt: -1 };
        else sortOption = { createdAt: -1 }; // Default to newest

        const products = await productModel.find(query)
            .sort(sortOption)
            .populate("category", "name") // Populate category name for UI
            .lean(); // Faster for read-only

        return res.json({
            success: true,
            count: products.length,
            products
        });


    } catch (error) {
        console.error("getProducts error", error);
        return res.status(500).json({ error: "Internal server error" });
    }
}

// 3. Get Single Product (For "Product Inner" Page)
const getProductDetails = async (req, res) => {
    try {
        const { id } = req.params;

        if (!id) {
            return res.status(400).json({ error: "Product ID is required" });
        }

        const product = await productModel.findById(id).populate("category");

        if (!product) {
            return res.status(404).json({ error: "Product not found" });
        }

        return res.json({
            success: true,
            product
        });
    } catch (error) {
        console.error("getProductDetails error", error);
        return res.status(500).json({ error: "Internal server error" });
    }
}

// 4. Get Similar Products (Recommendation Engine)
// 4. Get Similar Products (Recommendation Engine)
// Logic: Finds products in same category AND matching Luxe status, excluding current one
const getSimilarProducts = async (req, res) => {
    try {
        const { id } = req.params;

        // 1. Find the current product to get its metadata
        const currentProduct = await productModel.findById(id);

        if (!currentProduct) {
            return res.status(404).json({ error: "Product not found" });
        }

        // 2. Build the similarity query
        const query = {
            _id: { $ne: currentProduct._id }, // Exclude the current product
            category: currentProduct.category, // Match category
            isLuxe: currentProduct.isLuxe      // Match the Luxe/Normal status
        };

        const similarProducts = await productModel.find(query)
            .limit(6)
            .select("title price thumbnail metal isLuxe")
            .lean();

        return res.json({
            success: true,
            products: similarProducts
        });

    } catch (error) {
        console.error("getSimilarProducts error", error);
        return res.status(500).json({ error: "Internal server error" });
    }
}
// // Logic: Finds products in the same category or matching tags, excluding the current one
// const getSimilarProducts = async (req, res) => {
//     try {
//         const { id } = req.params;

//         // First, find the current product to know its category/tags
//         const currentProduct = await productModel.findById(id);

//         if (!currentProduct) {
//             return res.status(404).json({ error: "Product not found" });
//         }

//         const similarProducts = await productModel.find({
//             category: currentProduct.category,
//             _id: { $ne: currentProduct._id } // Exclude current product
//         })
//             .limit(6) // Limit to 6 items for the UI
//             .select("title price thumbnail metal") // Select only needed fields for cards
//             .lean();

//         return res.json({
//             success: true,
//             products: similarProducts
//         });


//     } catch (error) {
//         console.error("getSimilarProducts error", error);
//         return res.status(500).json({ error: "Internal server error" });
//     }
// }

module.exports = {
    createProduct,
    getProducts,
    getProductDetails,
    getSimilarProducts
};