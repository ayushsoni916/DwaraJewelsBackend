const productModel = require("../models/product.model");
const wishlistModel = require("../models/wishlist.model");
const cloudinary = require("../config/cloudinary");

const addTotalStock = (product) => {
    const data = typeof product.toObject === 'function'
        ? product.toObject()
        : { ...product };

    // Exclude any old top-level stock still stored in MongoDB.
    delete data.stock;

    data.totalStock = Array.isArray(data.dimensions)
        ? data.dimensions.reduce(
            (total, option) => total + Number(option.stock ?? 0),
            0
        )
        : 0;

    return data;
};

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
            gender,
            // stock
        } = req.body;

        const parsedPrice = typeof price === 'string' ? JSON.parse(price) : price;
        const parsedMetal = typeof metal === 'string' ? JSON.parse(metal) : metal;
        const parsedStones = typeof stones === 'string' ? JSON.parse(stones) : stones;
        const parsedDimensions = typeof dimensions === 'string' ? JSON.parse(dimensions) : dimensions;
        const parsedTags = typeof tags === 'string' ? tags.split(',').map(t => t.trim()) : tags;

        if (!Array.isArray(parsedDimensions) || parsedDimensions.length === 0) {
            return res.status(400).json({
                error: "At least one dimension option with stock is required"
            });
        }

        if (!title || !sku || !parsedPrice || !parsedPrice.finalPrice || !category) {
            return res.status(400).json({
                error: "Title, SKU, Price, and Category are required",
                received: { title, sku, category, hasPrice: !!parsedPrice, finalPrice: parsedPrice?.finalPrice }
            });
        }

        if (!['Male', 'Female', 'Unisex'].includes(gender)) {
            return res.status(400).json({
                error: 'Select Male, Female, or Unisex',
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
            gender
            // stock: parseInt(stock) || 0
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
        const {
            category,
            subCategory,
            minPrice,
            maxPrice,
            sort,
            search,
            luxe,
            collection,
            isNewArrival,
            limit,
            page,
            metal,
            stone,
            size
        } = req.query;

        const query = {};

        if (req.query.gender) {
            if (!['Male', 'Female', 'Unisex'].includes(req.query.gender)) {
                return res.status(400).json({
                    error: 'Invalid gender filter',
                });
            }

            query.gender = req.query.gender;
        }

        if (category) {
            query.category = category;
        }

        if (subCategory) {
            query.subCategory = subCategory;
        }

        if (collection) {
            query.collection = collection;
        }

        if (isNewArrival === "true") {
            query.isNewArrival = true;
        } else if (isNewArrival === "false") {
            query.isNewArrival = { $ne: true };
        }

        if (luxe === "true") {
            query.isLuxe = true;
        } else if (luxe === "false") {
            query.isLuxe = { $ne: true };
        }

        if (minPrice || maxPrice) {
            query["price.finalPrice"] = {};

            if (minPrice) {
                query["price.finalPrice"].$gte = Number(minPrice);
            }

            if (maxPrice) {
                query["price.finalPrice"].$lte = Number(maxPrice);
            }
        }

        if (metal) {
            query["metal.type"] = metal;
        }

        if (stone) {
            query["stones.type"] = stone;
        }

        if (size) {
            query["dimensions.size"] = size;
        }

        // Partial search: "rin" will match "ring"
        if (search?.trim()) {
            const escapedSearch = search
                .trim()
                .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

            const searchRegex = new RegExp(escapedSearch, "i");

            query.$or = [
                { title: { $regex: searchRegex } },
                { description: { $regex: searchRegex } },
                { tags: { $regex: searchRegex } },
                { sku: { $regex: searchRegex } },
                { subCategory: { $regex: searchRegex } },
                { "metal.type": { $regex: searchRegex } },
                { "metal.quality": { $regex: searchRegex } },
                { "metal.color": { $regex: searchRegex } },
                { "stones.type": { $regex: searchRegex } },
                { "stones.shape": { $regex: searchRegex } }
            ];
        }

        let sortOption = { createdAt: -1 };

        if (sort === "price_low_high") {
            sortOption = { "price.finalPrice": 1 };
        } else if (sort === "price_high_low") {
            sortOption = { "price.finalPrice": -1 };
        } else if (sort === "oldest") {
            sortOption = { createdAt: 1 };
        }

        // Pagination is only applied when page or limit is supplied
        const shouldPaginate =
            page !== undefined || limit !== undefined;

        const pageNumber = Math.max(
            parseInt(page, 10) || 1,
            1
        );

        const pageSize = Math.min(
            Math.max(parseInt(limit, 10) || 8, 1),
            50
        );

        let dbQuery = productModel
            .find(query)
            .sort(sortOption)
            .populate("category", "name")
            .populate("collection", "name")
            .lean();

        if (shouldPaginate) {
            dbQuery = dbQuery
                .skip((pageNumber - 1) * pageSize)
                .limit(pageSize);
        }

        const [total, fetchedProducts] = await Promise.all([
            productModel.countDocuments(query),
            dbQuery
        ]);

        let products = fetchedProducts.map(addTotalStock);

        if (req.user) {
            const wishlist = await wishlistModel
                .findOne({ user: req.user.id })
                .select("products")
                .lean();

            const wishlistedIds = new Set(
                (wishlist?.products || []).map(productId =>
                    productId.toString()
                )
            );

            products = products.map(product => ({
                ...product,
                isWishlisted: wishlistedIds.has(
                    product._id.toString()
                )
            }));
        } else {
            products = products.map(product => ({
                ...product,
                isWishlisted: false
            }));
        }

        const totalPages = shouldPaginate
            ? Math.ceil(total / pageSize)
            : total > 0
                ? 1
                : 0;

        const hasMore = shouldPaginate
            ? pageNumber * pageSize < total
            : false;

        return res.status(200).json({
            success: true,
            count: products.length,
            total,
            page: pageNumber,
            limit: shouldPaginate ? pageSize : total,
            totalPages,
            hasMore,
            products
        });
    } catch (error) {
        console.error("getProducts error:", error);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
};

// 3. Get Single Product (For "Product Inner" Page)
const getProductDetails = async (req, res) => {
    try {
        const { id } = req.params;

        if (!id) {
            return res.status(400).json({ error: "Product ID is required" });
        }

        const product = await productModel
            .findById(id)
            .populate("category")
            .populate("collection", "name");

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
            product: addTotalStock(product),
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

const validProductId = value =>
    typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);

const productActionError = (message, statusCode = 400) =>
    Object.assign(new Error(message), { statusCode });

const parseProductField = value => {
    if (typeof value !== 'string') return value;

    try {
        return JSON.parse(value);
    } catch {
        throw productActionError('Invalid JSON in product fields');
    }
};

const sendProductActionError = (res, error) => {
    console.error('Product action error:', error);

    const validationError =
        error.name === 'ValidationError' ||
        error.name === 'CastError';

    return res.status(
        error.code === 11000
            ? 409
            : error.statusCode || (validationError ? 400 : 500)
    ).json({
        success: false,
        error: error.code === 11000
            ? 'SKU already exists'
            : error.statusCode || validationError
                ? error.message
                : 'Unable to complete product request',
    });
};

// Admin list includes inactive products.
module.exports.getAdminProducts = async (req, res) => {
    try {
        const query = {};

        if (req.query.gender) {
            if (!['Male', 'Female', 'Unisex'].includes(req.query.gender)) {
                return res.status(400).json({
                    error: 'Invalid gender filter',
                });
            }

            query.gender = req.query.gender;
        }

        const page = Number(req.query.page ?? 1);
        const limit = Number(req.query.limit ?? 10);
        const skip = (page - 1) * limit;

        if (
            !Number.isSafeInteger(page) ||
            page < 1 ||
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > 50 ||
            !Number.isSafeInteger(skip)
        ) {
            throw productActionError(
                'Invalid pagination. Page must be positive and limit must be 1–50.'
            );
        }

        for (const field of ['category', 'collection']) {
            if (req.query[field]) {
                if (!validProductId(req.query[field])) {
                    throw productActionError(`Invalid ${field} ID`);
                }

                query[field] = req.query[field];
            }
        }

        for (const [parameter, field] of [
            ['luxe', 'isLuxe'],
            ['isNewArrival', 'isNewArrival'],
        ]) {
            const value = req.query[parameter];

            if (value !== undefined) {
                if (value !== 'true' && value !== 'false') {
                    throw productActionError(
                        `${parameter} must be true or false`
                    );
                }

                query[field] = value === 'true'
                    ? true
                    : { $ne: true };
            }
        }

        const { search, stock, isActive } = req.query;
        const sort = req.query.sort ?? 'newest';

        if (search !== undefined) {
            if (typeof search !== 'string') {
                throw productActionError('Invalid search');
            }

            if (search.trim()) {
                const escapedSearch = search
                    .trim()
                    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

                const searchRegex = new RegExp(escapedSearch, 'i');

                query.$or = [
                    { title: searchRegex },
                    { sku: searchRegex },
                ];
            }
        }

        if (isActive !== undefined) {
            if (isActive !== 'true' && isActive !== 'false') {
                throw productActionError('Invalid active status');
            }

            // Older products without isActive are treated as active.
            query.isActive = isActive === 'true'
                ? { $ne: false }
                : false;
        }

        if (stock !== undefined) {
            if (!['in_stock', 'out_of_stock'].includes(stock)) {
                throw productActionError('Invalid stock filter');
            }

            query.dimensions = stock === 'in_stock'
                ? {
                    $elemMatch: { stock: { $gt: 0 } },
                }
                : {
                    $not: {
                        $elemMatch: { stock: { $gt: 0 } },
                    },
                };
        }

        const sortOptions = {
            newest: { createdAt: -1, _id: -1 },
            oldest: { createdAt: 1, _id: 1 },
            price_low_high: { 'price.finalPrice': 1, _id: 1 },
            price_high_low: { 'price.finalPrice': -1, _id: -1 },
        };

        if (!Object.hasOwn(sortOptions, sort)) {
            throw productActionError('Invalid sorting option');
        }

        const sortOption = sortOptions[sort];

        // Includes active and inactive products for the dashboard.
        const [total, products] = await Promise.all([
            productModel.countDocuments(query),

            productModel.find(query)
                .populate('category', 'name')
                .populate('collection', 'name')
                .sort(sortOption)
                .skip(skip)
                .limit(limit)
                .lean(),
        ]);

        return res.json({
            success: true,
            products: products.map(addTotalStock),
            count: products.length,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
            hasMore: skip + products.length < total,
        });
    } catch (error) {
        return sendProductActionError(res, error);
    }
};

module.exports.getAdminProduct = async (req, res) => {
    try {
        if (!validProductId(req.params.productId)) {
            throw productActionError('Invalid product ID');
        }

        const product = await productModel
            .findById(req.params.productId)
            .populate('category')
            .populate('collection', 'name');

        if (!product) {
            throw productActionError('Product not found', 404);
        }

        return res.json({ success: true, product });
    } catch (error) {
        return sendProductActionError(res, error);
    }
};

module.exports.setProductActive = async (req, res) => {
    try {
        const { productId } = req.params;
        const { isActive } = req.body;

        if (!validProductId(productId)) {
            throw productActionError('Invalid product ID');
        }

        if (typeof isActive !== 'boolean') {
            throw productActionError('isActive must be true or false');
        }

        const product = await productModel.findByIdAndUpdate(
            productId,
            { $set: { isActive } },
            { new: true, runValidators: true }
        );

        if (!product) {
            throw productActionError('Product not found', 404);
        }

        return res.json({
            success: true,
            message: isActive ? 'Product activated' : 'Product deactivated',
            product,
        });
    } catch (error) {
        return sendProductActionError(res, error);
    }
};

module.exports.updateAdminProduct = async (req, res) => {
    const uploadedImages = [];
    let saved = false;

    try {
        const { productId } = req.params;

        if (!validProductId(productId)) {
            throw productActionError('Invalid product ID');
        }

        const product = await productModel.findById(productId);

        if (!product) {
            throw productActionError('Product not found', 404);
        }

        const expectedUpdatedAt = new Date(req.body.expectedUpdatedAt);

        if (
            Number.isNaN(expectedUpdatedAt.getTime()) ||
            expectedUpdatedAt.getTime() !== product.updatedAt.getTime()
        ) {
            throw productActionError(
                'Product or stock changed. Reload the product before saving.',
                409
            );
        }

        const dimensions = parseProductField(req.body.dimensions);

        if (!Array.isArray(dimensions) || !dimensions.length) {
            throw productActionError('At least one dimension is required');
        }

        const existingIds = new Set(
            product.dimensions.map(dimension => String(dimension._id))
        );

        const receivedIds = new Set();

        const normalizedDimensions = dimensions.map(dimension => {
            if (
                !dimension ||
                !['string', 'number'].includes(typeof dimension.stock) ||
                String(dimension.stock).trim() === '' ||
                !Number.isSafeInteger(Number(dimension.stock)) ||
                Number(dimension.stock) < 0
            ) {
                throw productActionError('Invalid dimension stock');
            }

            if (dimension._id) {
                if (
                    !existingIds.has(String(dimension._id)) ||
                    receivedIds.has(String(dimension._id))
                ) {
                    throw productActionError('Invalid or duplicate dimension ID');
                }

                receivedIds.add(String(dimension._id));
            }

            return {
                ...(dimension._id && { _id: dimension._id }),
                width: dimension.width,
                length: dimension.length,
                size: dimension.size,
                stock: Number(dimension.stock),
            };
        });

        if ([...existingIds].some(id => !receivedIds.has(id))) {
            throw productActionError(
                'Keep existing dimensions and set their stock to 0 instead'
            );
        }

        if (
            typeof req.body.title !== 'string' ||
            !req.body.title.trim() ||
            typeof req.body.sku !== 'string' ||
            !req.body.sku.trim() ||
            !validProductId(req.body.category)
        ) {
            throw productActionError('Title, SKU and category are required');
        }

        if (req.body.collection && !validProductId(req.body.collection)) {
            throw productActionError('Invalid collection ID');
        }

        if (!['Male', 'Female', 'Unisex'].includes(req.body.gender)) {
            throw productActionError('Select Male, Female, or Unisex');
        }

        const changes = {
            title: req.body.title.trim(),
            sku: req.body.sku.trim(),
            description: req.body.description || '',
            category: req.body.category,
            subCategory: req.body.subCategory || '',
            collection: req.body.collection || null,
            price: parseProductField(req.body.price),
            metal: parseProductField(req.body.metal),
            stones: parseProductField(req.body.stones),
            dimensions: normalizedDimensions,
            gender: req.body.gender,
            tags: String(req.body.tags || '')
                .split(',')
                .map(tag => tag.trim())
                .filter(Boolean),
            isNewArrival: req.body.isNewArrival === 'true',
            isLuxe: req.body.isLuxe === 'true',
        };

        // Validate fields before uploading images.
        const candidate = new productModel({
            ...product.toObject(),
            ...changes,
        });

        await candidate.validate();

        const files = req.files || [];
        const imageOrder = parseProductField(req.body.imageOrder);

        if (!Array.isArray(imageOrder) || !imageOrder.length) {
            throw productActionError('At least one image is required');
        }

        const existingUrls = new Set([
            ...product.images,
            ...(product.thumbnail ? [product.thumbnail] : []),
        ]);

        const usedFiles = new Set();
        const usedUrls = new Set();

        for (const image of imageOrder) {
            if (image?.type === 'existing') {
                if (
                    !existingUrls.has(image.url) ||
                    usedUrls.has(image.url)
                ) {
                    throw productActionError('Invalid existing image');
                }

                usedUrls.add(image.url);
            } else if (image?.type === 'new') {
                if (
                    !Number.isInteger(image.index) ||
                    image.index < 0 ||
                    !files[image.index] ||
                    usedFiles.has(image.index)
                ) {
                    throw productActionError('Invalid uploaded image');
                }

                usedFiles.add(image.index);
            } else {
                throw productActionError('Invalid image order');
            }
        }

        if (usedFiles.size !== files.length) {
            throw productActionError('Invalid uploaded image order');
        }

        for (const file of files) {
            const result = await new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    { folder: 'dwara_products', resource_type: 'image' },
                    (error, result) =>
                        error ? reject(error) : resolve(result)
                );

                stream.end(file.buffer);
            });

            uploadedImages.push({
                url: result.secure_url,
                publicId: result.public_id,
            });
        }

        const imageDetails = imageOrder.map(image =>
            image.type === 'new'
                ? uploadedImages[image.index]
                : {
                    url: image.url,
                    publicId: product.imageDetails.find(
                        existing => existing.url === image.url
                    )?.publicId,
                }
        );

        const normalized = candidate.toObject();

        for (const field of Object.keys(changes)) {
            changes[field] = normalized[field];
        }

        changes.images = imageDetails.map(image => image.url);
        changes.thumbnail = changes.images[0];
        changes.imageDetails = imageDetails;

        const updatedProduct = await productModel.findOneAndUpdate(
            {
                _id: productId,
                updatedAt: expectedUpdatedAt,
            },
            { $set: changes },
            { new: true, runValidators: true }
        );

        if (!updatedProduct) {
            throw productActionError(
                'Product or stock changed. Reload before saving.',
                409
            );
        }

        saved = true;

        return res.json({
            success: true,
            message: 'Product updated successfully',
            product: updatedProduct,
        });
    } catch (error) {
        if (!saved) {
            await Promise.allSettled(
                uploadedImages.map(image =>
                    cloudinary.uploader.destroy(image.publicId)
                )
            );
        }

        return sendProductActionError(res, error);
    }
};

module.exports = {
    ...module.exports,
    createProduct,
    getProducts,
    getProductDetails,
    getSimilarProducts,
};