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
        const { productId, quantity, size } = req.body;
        const userId = req.user.id;

        // --- STEP A: ADD TO CART (Reusing your logic) ---
        const qty = quantity ? parseInt(quantity) : 1;
        const incomingSize = size !== undefined && size !== null ? String(size) : null;

        const product = await productModel.findById(productId);
        if (!product) return res.status(404).json({ error: "Product not found" });

        let cart = await Cart.findOne({ user: userId });

        if (!cart) {
            cart = await Cart.create({
                user: userId,
                items: [{ product: productId, quantity: qty, size: incomingSize }]
            });
        } else {
            const itemIndex = cart.items.findIndex(item => {
                return item.product.toString() === productId && 
                       (String(item.size) === incomingSize);
            });

            if (itemIndex > -1) {
                cart.items[itemIndex].quantity += qty;
            } else {
                cart.items.push({ product: productId, quantity: qty, size: incomingSize });
            }
            await cart.save();
        }

        // --- STEP B: REMOVE FROM WISHLIST ---
        await Wishlist.findOneAndUpdate(
            { user: userId },
            { $pull: { products: productId } }
        );

        res.status(200).json({
            success: true,
            message: "Item moved to cart successfully"
        });

    } catch (error) {
        console.error("moveToCart error", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

// 3. Get Wishlist with populated products
exports.getWishlist = async (req, res) => {
    try {
        const userId = req.user.id;
        const wishlist = await Wishlist.findOne({ user: userId }).populate({
            path: 'products',
            select: 'title price thumbnail category'
        });

        res.status(200).json({
            success: true,
            products: wishlist ? wishlist.products : []
        });
    } catch (error) {
        res.status(500).json({ error: "Internal server error" });
    }
};