const Cart = require("../models/cart.model");
const Coupon = require("../models/coupon.model");
const productModel = require("../models/product.model");

const round2 = (num) => Math.round(num * 100) / 100;

// Helper: Recalculate Totals & Format Response
const calculateCartResponse = async (cart) => {
    // 1. Filter invalid items (if a product was deleted from DB)
    cart.items = cart.items.filter(item => item.product);

    let totalQty = 0;
    let subtotal = 0;

    if (cart.items.length === 0) {
        if (cart.couponCode) {
            cart.couponCode = null;
            await cart.save();
            console.log("Cart empty: Coupon automatically removed.");
        }
        return {
            _id: cart._id,
            items: [],
            coupon: null,
            summary: { totalQty: 0, subtotal: 0, discount: 0, tax: 0, shipping: 0, totalCost: 0 }
        };
    }

    // 2. Map items to format & calculate subtotal
    const formattedItems = cart.items.map(item => {
        // LIVE PRICE CHECK: Always use the current product price
        const currentPrice = item.product.price?.finalPrice || 0;
        const itemTotal = currentPrice * item.quantity;

        totalQty += item.quantity;
        subtotal += itemTotal;

        return {
            _id: item._id,
            productId: item.product._id,
            title: item.product.title,
            thumbnail: item.product.thumbnail,
            price: currentPrice,
            quantity: item.quantity,
            size: item.size,
            itemTotal: itemTotal
        };
    });

    // 3. Coupon Logic (Placeholder for now)
    let discount = 0;
    let appliedCoupon = null;

    if (cart.couponCode) {
        const coupon = await Coupon.findOne({
            code: cart.couponCode,
            isActive: true,
            expiresAt: { $gt: new Date() }
        });

        // Check if coupon exists AND meets minimum order value
        if (coupon && subtotal >= coupon.minOrderValue) {
            if (coupon.discountType === 'PERCENTAGE') {
                discount = (subtotal * coupon.value) / 100;
                if (coupon.maxDiscountAmount) {
                    discount = Math.min(discount, coupon.maxDiscountAmount);
                }
            } else {
                discount = coupon.value;
            }
            appliedCoupon = {
                code: coupon.code,
                description: coupon.description,
                discountValue: discount
            };
        }
        else {
            /** * AUTO-CLEANUP: 
             * If the code exists in DB but is no longer valid (expired or subtotal dropped),
             * we remove it from the cart document so the user doesn't see a "ghost" discount.
             */
            cart.couponCode = null;
            await cart.save();
            // console.log(`Coupon ${coupon ? coupon.code : 'unknown'} removed due to invalidity/low subtotal.`);
        }
    }

    // 4. Final Math
    const tax = 0; // or subtotal * 0.18
    const shipping = subtotal > 5000 ? 0 : 100; // Example: Free shipping over 5000
    const totalCost = subtotal + tax + shipping - discount;

    return {
        _id: cart._id,
        items: formattedItems,
        coupon: appliedCoupon,
        summary: {
            totalQty,
            subtotal: round2(subtotal),
            discount: round2(discount),
            tax: round2(tax),
            shipping: round2(shipping),
            totalCost: round2(Math.max(0, totalCost))
        }
    };
};

const addToCart = async (req, res) => {
    try {
        const { productId, quantity, size } = req.body;
        const userId = req.user.id

        if (!productId) {
            return res.status(400).json({ error: "Product ID is required" });
        }

        // Validate quantity (default to 1 if not sent)
        const qty = quantity ? parseInt(quantity) : 1;
        const incomingSize = size !== undefined && size !== null ? String(size) : null;

        if (qty < 1) {
            return res.status(400).json({ error: "Quantity must be at least 1" });
        }

        // Check if product exists and has stock
        const product = await productModel.findById(productId);
        if (!product) {
            return res.status(404).json({ error: "Product not found" });
        }
        // TODO: Add stock check here (if stock < qty, throw error)

        // Find existing cart for user
        let cart = await Cart.findOne({ user: userId });
        let msg = '';

        if (!cart) {
            // --- SCENARIO 1: No Cart exists, create new one ---
            console.log("Creating new cart for user:", userId);
            cart = await Cart.create({
                user: userId,
                items: [{
                    product: productId,
                    quantity: qty,
                    size: incomingSize
                }]
            })
            msg = 'Product added to cart successfully';
        }
        else {
            // --- SCENARIO 2: Cart exists ---

            // Check if this specific product (AND size) is already in cart
            console.log("Updating existing cart for user:", userId);
            const itemIndex = cart.items.findIndex(item => {
                const isSameProduct = item.product.toString() === productId;

                // Ensure the DB value is also treated as a string for comparison
                const dbSize = item.size !== undefined && item.size !== null ? String(item.size) : null;

                return isSameProduct && (dbSize === incomingSize);
            });

            if (itemIndex > -1) {
                // Item exists: Update quantity
                cart.items[itemIndex].quantity += qty;
                console.log("Updated item quantity in cart");
                msg = 'Product quantity updated in cart successfully';
            } else {
                // Item doesn't exist: Push new item
                cart.items.push({
                    product: productId,
                    quantity: qty,
                    size: incomingSize
                });
                console.log("Added new item to cart");
                msg = 'Product added to cart successfully';
            }

            await cart.save();
        }

        console.log("Cart after operation:", cart);

        return res.status(200).json({
            success: true,
            message: msg
        });
    }
    catch (error) {
        console.error("addToCart error", error);
        return res.status(500).json({ error: "Internal server error" });
    }
}

const getCart = async (req, res) => {
    try {
        const userId = req.user.id;
        // Find cart and populate product details
        // We only need specific fields like title, price, thumbnail

        const cart = await Cart.findOne({ user: userId })
            .populate({
                'path': 'items.product',
                'select': 'title price thumbnail quantity'
            })

        if (!cart) {
            return res.status(200).json({
                success: true,
                cart: {
                    items: [],
                    summary: { totalQty: 0, subTotal: 0, tax: 0, shipping: 0, totalPayable: 0, discount: 0 }
                }
            });
        }

        // Use the shared helper to format the response
        const cartResponse = await calculateCartResponse(cart);

        return res.status(200).json({
            success: true,
            cart: cartResponse
        });

        // // Calculate Totals on the fly
        // let totalQty = 0;
        // let totalPrice = 0;

        // // Filter out items where product might have been deleted from DB
        // const validItems = cart.items.filter(item => item.product);

        // const formattedItems = validItems.map(item => {
        //     const currentPrice = item.product.price?.finalPrice || 0;
        //     const itemTotal = currentPrice * item.quantity;

        //     totalQty += item.quantity;
        //     totalPrice += itemTotal;

        //     return {
        //         _id: item._id, // Cart Item ID (needed for delete/update)
        //         productId: item.product._id,
        //         title: item.product.title,
        //         thumbnail: item.product.thumbnail,
        //         price: currentPrice, // Live Price
        //         quantity: item.quantity,
        //         size: item.size,
        //         itemTotal: itemTotal
        //     }
        // })

        // const summary = {
        //     totalQty,
        //     subTotal: totalPrice,
        //     tax: 0,
        //     shipping: 0,
        //     totalPayable: totalPrice
        // }

        // return res.status(200).json({
        //     success: true,
        //     cart: {
        //         _id: cart._id,
        //         items: formattedItems,
        //         summary
        //     }
        // });
    }
    catch (error) {
        console.error("getCart error", error);
        return res.status(500).json({ error: "Internal server error" });
    }
}

// 3. Update Cart Item (Increment/Decrement)
const updateCartItem = async (req, res) => {
    try {
        const userId = req.user.id;
        const { itemId, type } = req.body; // type: 'increment' or 'decrement'

        // Populate is needed because calculateCartResponse relies on product details
        const cart = await Cart.findOne({ user: userId }).populate({
            path: 'items.product',
            select: 'title price thumbnail quantity'
        });

        if (!cart) return res.status(404).json({ error: "Cart not found" });

        // Find the item using the Cart Item _id (not Product ID)
        const itemIndex = cart.items.findIndex(item => item._id.toString() === itemId);

        if (itemIndex === -1) {
            return res.status(404).json({ error: "Item not found in cart" });
        }

        if (type === 'increment') {
            cart.items[itemIndex].quantity += 1;
        } else if (type === 'decrement') {
            if (cart.items[itemIndex].quantity > 1) {
                cart.items[itemIndex].quantity -= 1;
            } else {
                return res.status(400).json({ error: "Quantity cannot be less than 1" });
            }
        } else {
            return res.status(400).json({ error: "Invalid update type" });
        }

        await cart.save();

        // Return the updated summary so frontend updates instantly
        const cartResponse = await calculateCartResponse(cart);

        return res.status(200).json({
            success: true,
            message: "Cart updated successfully",
            cart: cartResponse
        });

    } catch (error) {
        console.error("updateCartItem error", error);
        return res.status(500).json({ error: "Internal server error" });
    }
};

// 4. Remove Item from Cart
const removeCartItem = async (req, res) => {
    try {
        const userId = req.user.id;
        const { itemId } = req.params; // Expecting ID in URL param
        console.log(`User ${userId} requested removal of Item ID: ${itemId}`);

        const cart = await Cart.findOne({ user: userId }).populate({
            path: 'items.product',
            select: 'title price thumbnail quantity'
        });

        if (!cart) return res.status(404).json({ error: "Cart not found" });
        console.log(`User ${userId} removing Item ID: ${itemId}`);
        // Filter out the item to be removed
        const newItems = cart.items.filter(item => item._id.toString() !== itemId);

        cart.items = newItems;
        await cart.save();

        const cartResponse = await calculateCartResponse(cart);

        return res.status(200).json({
            success: true,
            message: "Item removed from cart",
            cart: cartResponse
        });

    } catch (error) {
        console.error("removeCartItem error", error);
        return res.status(500).json({ error: "Internal server error" });
    }
};

// 5. Apply Coupon
const applyCoupon = async (req, res) => {
    try {
        const userId = req.user.id;
        const { couponCode } = req.body;

        if (!couponCode) return res.status(400).json({ error: "Coupon code is required" });

        // 1. Find the coupon
        const coupon = await Coupon.findOne({
            code: couponCode.toUpperCase(),
            isActive: true,
            expiresAt: { $gt: new Date() }
        });

        if (!coupon) return res.status(400).json({ error: "Invalid or expired coupon code" });

        // 2. Find the cart
        const cart = await Cart.findOne({ user: userId }).populate('items.product');
        if (!cart || cart.items.length === 0) return res.status(400).json({ error: "Cart is empty" });

        // 3. Calculate current subtotal to check minOrderValue
        let subtotal = 0;
        cart.items.forEach(item => {
            if (item.product) subtotal += (item.product.price?.finalPrice || 0) * item.quantity;
        });

        if (subtotal < coupon.minOrderValue) {
            return res.status(400).json({
                error: `This coupon requires a minimum order of Rs. ${coupon.minOrderValue}`
            });
        }

        // 4. Save and return updated cart
        cart.couponCode = coupon.code;
        await cart.save();

        const cartResponse = await calculateCartResponse(cart);

        return res.status(200).json({
            success: true,
            message: "Coupon applied successfully",
            cart: cartResponse
        });

    } catch (error) {
        console.error("applyCoupon error", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

// 1. Create Coupon (Admin Only)
const createCoupon = async (req, res) => {
    try {
        const {
            code,
            description,
            discountType,
            value,
            minOrderValue,
            maxDiscountAmount,
            expiresAt
        } = req.body;

        // Validation
        if (!code || !value || !expiresAt) {
            return res.status(400).json({ error: "Missing required coupon fields" });
        }

        const existingCoupon = await Coupon.findOne({ code: code.toUpperCase() });
        if (existingCoupon) {
            return res.status(400).json({ error: "Coupon code already exists" });
        }

        const newCoupon = await Coupon.create({
            code: code.toUpperCase(),
            description,
            discountType,
            value,
            minOrderValue,
            maxDiscountAmount,
            expiresAt: new Date(expiresAt)
        });

        res.status(201).json({
            success: true,
            message: "Coupon created successfully",
            coupon: newCoupon
        });
    } catch (error) {
        console.error("createCoupon error", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

// 2. Get All Active Coupons (For User to see in "Available Offers")
const getAllCoupons = async (req, res) => {
    try {
        const coupons = await Coupon.find({
            isActive: true,
            expiresAt: { $gt: new Date() } // Only show non-expired coupons
        }).sort({ createdAt: -1 });

        res.status(200).json({
            success: true,
            coupons
        });
    } catch (error) {
        console.error("getAllCoupons error", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

module.exports = {
    addToCart,
    getCart,
    updateCartItem,
    removeCartItem,
    applyCoupon,
    createCoupon,
    getAllCoupons
}