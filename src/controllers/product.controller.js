const productModel = require("../models/product.model");
const wishlistModel = require("../models/wishlist.model");
const cloudinary = require("../config/cloudinary");

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
            tags,
            isNewArrival,
            isLuxe,
            stock
        } = req.body;

        const parsedPrice = typeof price === 'string' ? JSON.parse(price) : price;
        const parsedMetal = typeof metal === 'string' ? JSON.parse(metal) : metal;
        const parsedStones = typeof stones === 'string' ? JSON.parse(stones) : stones;
        const parsedDimensions = typeof dimensions === 'string' ? JSON.parse(dimensions) : dimensions;
        const parsedTags = typeof tags === 'string' ? tags.split(',').map(t => t.trim()) : tags;

        if (!title || !sku || !parsedPrice || !parsedPrice.finalPrice || !category) {
            return res.status(400).json({ 
                error: "Title, SKU, Price, and Category are required",
                received: { title, sku, category, hasPrice: !!parsedPrice, finalPrice: parsedPrice?.finalPrice }
            });
        }


        const files = req.files; // Expecting array from multer: upload.array('images')
        if (!files || files.length === 0) {
            return res.status(400).json({ error: "At least one product image is required" });
        }

        // Check if SKU already exists
        const existingProduct = await productModel.findOne({ sku });
        if (existingProduct) {
            return res.status(400).json({ error: "Product with this SKU already exists" });
        }

        // 1. Upload Gallery to Cloudinary
        const uploadPromises = files.map(file => {
            return new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    { folder: "dwara_products" },
                    (err, result) => {
                        if (err) reject(err);
                        else resolve({ url: result.secure_url, publicId: result.public_id });
                    }
                );
                stream.end(file.buffer);
            });
        });

        const uploadedResults = await Promise.all(uploadPromises);

        // 2. Map results for both live app (Strings) and admin management (Objects)
        const imageUrls = uploadedResults.map(img => img.url);
        const thumbnail = imageUrls[0]; // First image is the thumbnail




        const product = await productModel.create({
            title,
            sku,
            description,
            category,
            subCategory,
            collection,
            price: parsedPrice,
            metal: parsedMetal,
            stones: parsedStones,
            dimensions: parsedDimensions,
            images: imageUrls,      // String array for frontend
            thumbnail: thumbnail,   // String for frontend
            imageDetails: uploadedResults, // Object array for backend management
            tags: parsedTags,
            isNewArrival: isNewArrival === 'true' || isNewArrival === true,
            isLuxe: isLuxe === 'true' || isLuxe === true,
            stock: parseInt(stock) || 0
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

        let products = await productModel.find(query)
            .sort(sortOption)
            .populate("category", "name") // Populate category name for UI
            .lean(); // Faster for read-only

        // --- WISHLIST LOGIC ---
        if (req.user) {
            const wishlist = await wishlistModel.findOne({ user: req.user.id });
            const wishlistedIds = wishlist ? wishlist.products.map(p => p.toString()) : [];

            products = products.map(product => ({
                ...product,
                isWishlisted: wishlistedIds.includes(product._id.toString())
            }));
        } else {
            // Guest users see everything as NOT wishlisted
            products = products.map(product => ({
                ...product,
                isWishlisted: false
            }));
        }

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

        // --- WISHLIST LOGIC ---
        let isWishlisted = false;
        if (req.user) {
            const wishlist = await wishlistModel.findOne({ user: req.user.id });
            if (wishlist) {
                isWishlisted = wishlist.products.includes(id);
            }
        }

        return res.json({
            success: true,
            product,
            isWishlisted
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

module.exports = {
    createProduct,
    getProducts,
    getProductDetails,
    getSimilarProducts
};