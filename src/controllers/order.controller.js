const Order = require("../models/order.model");
const Cart = require("../models/cart.model");

exports.placeOrder = async (req, res) => {
    try {
        const userId = req.user.id;
        const { shippingAddress, paymentType } = req.body;

        // 1. Fetch Cart and Populate Product details
        const cart = await Cart.findOne({ user: userId }).populate('items.product');
        if (!cart || cart.items.length === 0) {
            return res.status(400).json({ error: "Cart is empty" });
        }

        // 2. Server-side Calculation (Security Check)
        let subtotal = 0;
        const orderItems = cart.items.map(item => {
            const price = item.product.price?.finalPrice || 0;
            subtotal += price * item.quantity;
            
            return {
                product: item.product._id,
                quantity: item.quantity,
                size: item.size,
                priceAtPurchase: price
            };
        });

        // Add your business logic for shipping/tax
        const shipping = subtotal > 5000 ? 0 : 100; 
        const totalCost = subtotal + shipping;

        // 3. Create the Order
        const newOrder = await Order.create({
            user: userId,
            items: orderItems,
            shippingAddress,
            paymentType, // e.g., "COD"
            summary: {
                subtotal,
                shipping,
                totalCost
            },
            status: 'Pending'
        });

        // 4. Clear the user's cart
        await Cart.findOneAndDelete({ user: userId });

        // 5. Populate for the "Thank You" screen
        const populatedOrder = await Order.findById(newOrder._id)
            .populate('items.product', 'title thumbnail');

        res.status(201).json({
            success: true,
            order: populatedOrder
        });

    } catch (error) {
        console.error("Order Error:", error);
        res.status(500).json({ error: "Order failed" });
    }
};

exports.getMyOrders = async (req, res) => {
    try {
        const orders = await Order.find({ user: req.user.id })
            .populate('items.product', 'title thumbnail')
            .sort({ createdAt: -1 });

        res.status(200).json({ success: true, orders });
    } catch (error) {
        res.status(500).json({ error: "Internal server error" });
    }
};