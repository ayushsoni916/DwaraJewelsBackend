const Wishlist = require("../models/wishlist.model");
const Cart = require("../models/cart.model");
const productModel = require("../models/product.model");

// 1. Toggle Wishlist (Add/Remove)
exports.toggleWishlist = async (req, res) => {
    try {
        const { productId } = req.body;
        const userId = req.user.id;

        let wishlist = await Wishlist.findOne({ user: userId });

        if (!wishlist) {
            wishlist = await Wishlist.create({ user: userId, products: [productId] });
            return res.status(200).json({ success: true, message: "Added to wishlist", isWishlisted: true });
        }

        const index = wishlist.products.indexOf(productId);
        if (index > -1) {
            wishlist.products.splice(index, 1);
            await wishlist.save();
            return res.status(200).json({ success: true, message: "Removed from wishlist", isWishlisted: false });
        } else {
            wishlist.products.push(productId);
            await wishlist.save();
            return res.status(200).json({ success: true, message: "Added to wishlist", isWishlisted: true });
        }
    } catch (error) {
        console.error("toggleWishlist error", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

// 2. Move to Cart
exports.moveToCart = async (req, res) => {
    try {
        const { productId, dimensionId, quantity = 1 } = req.body;
        const userId = req.user.id;

        const validId = value =>
            typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);

        if (!validId(productId) || !validId(dimensionId)) {
            return res.status(400).json({
                error: "Valid productId and dimensionId are required"
            });
        }

        const qty = Number(quantity);

        if (
            !['number', 'string'].includes(typeof quantity) ||
            !Number.isSafeInteger(qty) ||
            qty < 1
        ) {
            return res.status(400).json({
                error: "Quantity must be a positive whole number"
            });
        }

        const fail = (status, message) => {
            throw Object.assign(new Error(message), { status });
        };

        // Add to cart and remove from wishlist together.
        await Cart.db.transaction(async session => {
            const wishlist = await Wishlist.findOne({
                user: userId,
                products: productId
            }).session(session);

            if (!wishlist) {
                fail(409, "Product is no longer in your wishlist");
            }

            const product = await productModel
                .findById(productId)
                .session(session);

            if (!product) {
                fail(404, "Product not found");
            }

            const dimension = product.dimensions.find(
                option =>
                    String(option._id) === dimensionId.toLowerCase()
            );

            if (!dimension) {
                fail(400, "Selected dimension is unavailable");
            }

            const stock = Number(dimension.stock);

            if (!Number.isSafeInteger(stock) || stock <= 0) {
                fail(409, "Selected dimension is out of stock");
            }

            let cart = await Cart.findOne({
                user: userId
            }).session(session);

            if (!cart) {
                cart = new Cart({ user: userId, items: [] });
            }

            const matchingItems = cart.items.filter(item =>
                String(item.product) === String(product._id) &&
                String(item.dimensionId) === String(dimension._id)
            );

            const existingQuantity = matchingItems.reduce(
                (total, item) => total + Number(item.quantity),
                0
            );

            if (existingQuantity + qty > stock) {
                fail(
                    409,
                    `Only ${stock} available for this dimension. ` +
                    `You already have ${existingQuantity} in your cart.`
                );
            }

            if (matchingItems.length > 0) {
                matchingItems[0].quantity += qty;
                matchingItems[0].size = dimension.size || null;
            } else {
                cart.items.push({
                    product: product._id,
                    dimensionId: dimension._id,
                    size: dimension.size || null,
                    quantity: qty
                });
            }

            await cart.save({ session });

            await Wishlist.updateOne(
                { _id: wishlist._id },
                { $pull: { products: product._id } },
                { session }
            );
        });

        return res.status(200).json({
            success: true,
            message: "Item moved to cart successfully"
        });
    } catch (error) {
        console.error("moveToCart error", error);

        return res.status(error.status || 500).json({
            error: error.status
                ? error.message
                : "Internal server error"
        });
    }
};

// 3. Get Wishlist with populated products
exports.getWishlist = async (req, res) => {
    try {
        const userId = req.user.id;
        const wishlist = await Wishlist.findOne({ user: userId }).populate({
            path: 'products',
            select: 'title price thumbnail category dimensions isLuxe metal'
        });

        res.status(200).json({
            success: true,
            products: (wishlist?.products || []).filter(Boolean)
        });
    } catch (error) {
        res.status(500).json({ error: "Internal server error" });
    }
};