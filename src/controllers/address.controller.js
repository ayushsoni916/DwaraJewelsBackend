const addressModel = require("../models/address.model");

// 1. Add New Address
exports.addAddress = async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            firstName,
            lastName,
            phone,
            addressLine1,
            addressLine2,
            area,
            city,
            dist,
            state,
            pincode,
            addressType,
            isDefault
        } = req.body;

        // Validation for required fields
        if (!firstName || !lastName || !phone || !addressLine1 || !area || !city || !dist || !state || !pincode) {
            return res.status(400).json({ error: "Please fill all required address fields." });
        }

        // Logic: If this is set as default, remove 'isDefault' from all other addresses for this user
        if (isDefault) {
            await addressModel.updateMany(
                { user: userId },
                { isDefault: false }
            );
        }

        const address = await addressModel.create({
            user: userId,
            firstName,
            lastName,
            phone,
            addressLine1,
            addressLine2: addressLine2 || null,
            area,
            city,
            dist,
            state,
            pincode,
            addressType: addressType || 'Home',
            isDefault: isDefault || false
        });

        res.status(201).json({
            success: true,
            message: "Address added successfully",
            address
        });

    } catch (error) {
        console.error("addAddress error", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

// 2. Get All Addresses for User
exports.getAddresses = async (req, res) => {
    try {
        const userId = req.user.id;

        // Sort: show the default address first, then sort by newest
        const addresses = await addressModel.find({ user: userId })
            .sort({ isDefault: -1, createdAt: -1 });

        res.status(200).json({
            success: true,
            count: addresses.length,
            addresses
        });

    } catch (error) {
        console.error("getAddresses error", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

// 3. Get Default Address
exports.getDefaultAddress = async (req, res) => {
    try {
        const userId = req.user.id;

        // 1. Try to find the one marked as default
        let address = await addressModel.findOne({ user: userId, isDefault: true });

        // 2. Fallback: If no default exists, get the most recently created one
        if (!address) {
            address = await addressModel.findOne({ user: userId }).sort({ createdAt: -1 });
        }

        res.status(200).json({
            success: true,
            address: address || null // Returns null if user has 0 addresses
        });

    } catch (error) {
        console.error("getDefaultAddress error", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

// 4. Update Address
exports.updateAddress = async (req, res) => {
    try {
        const userId = req.user.id;
        const { addressId } = req.params;
        const updates = req.body;

        // Handle default logic if the update includes changing isDefault to true
        if (updates.isDefault) {
            await addressModel.updateMany({ user: userId }, { isDefault: false });
        }

        const updatedAddress = await addressModel.findOneAndUpdate(
            { _id: addressId, user: userId },
            updates,
            { new: true }
        );

        if (!updatedAddress) return res.status(404).json({ error: "Address not found" });

        res.status(200).json({
            success: true,
            message: "Address updated successfully",
            address: updatedAddress
        });

    } catch (error) {
        console.error("updateAddress error", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

// 5. Delete Address
exports.deleteAddress = async (req, res) => {
    try {
        const userId = req.user.id;
        const { addressId } = req.params;

        const deletedAddress = await addressModel.findOneAndDelete({ _id: addressId, user: userId });

        if (!deletedAddress) return res.status(404).json({ error: "Address not found" });

        res.status(200).json({
            success: true,
            message: "Address deleted successfully"
        });

    } catch (error) {
        console.error("deleteAddress error", error);
        res.status(500).json({ error: "Internal server error" });
    }
};