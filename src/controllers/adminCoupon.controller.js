const Coupon = require('../models/coupon.model');

const validId = value =>
    typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);

const validationError = message =>
    Object.assign(new Error(message), { statusCode: 400 });

const readNumber = (value, label) => {
    if (
        !['number', 'string'].includes(typeof value) ||
        String(value).trim() === ''
    ) {
        throw validationError(`${label} must be a number`);
    }

    const number = Number(value);

    if (!Number.isFinite(number)) {
        throw validationError(`${label} must be a valid number`);
    }

    return number;
};

const validateCoupon = data => {
    const code = typeof data.code === 'string'
        ? data.code.trim().toUpperCase()
        : '';

    const description = typeof data.description === 'string'
        ? data.description.trim()
        : '';

    if (!code || !description) {
        throw validationError('Code and description are required');
    }

    const discountType = data.discountType ?? 'FLAT';

    if (!['FLAT', 'PERCENTAGE'].includes(discountType)) {
        throw validationError('Invalid discount type');
    }

    const value = readNumber(data.value, 'Discount value');

    if (
        value <= 0 ||
        (discountType === 'PERCENTAGE' && value > 100)
    ) {
        throw validationError(
            'Discount must be positive and percentage cannot exceed 100'
        );
    }

    const minOrderValue = readNumber(
        data.minOrderValue ?? 0,
        'Minimum order value'
    );

    if (minOrderValue < 0) {
        throw validationError('Minimum order value cannot be negative');
    }

    let maxDiscountAmount;

    if (
        data.maxDiscountAmount !== undefined &&
        data.maxDiscountAmount !== null &&
        data.maxDiscountAmount !== ''
    ) {
        maxDiscountAmount = readNumber(
            data.maxDiscountAmount,
            'Maximum discount'
        );

        if (maxDiscountAmount <= 0) {
            throw validationError('Maximum discount must be positive');
        }
    }

    if (
        !['string', 'number'].includes(typeof data.expiresAt) &&
        !(data.expiresAt instanceof Date)
    ) {
        throw validationError('Expiry date is required');
    }

    const expiresAt = new Date(data.expiresAt);

    if (Number.isNaN(expiresAt.getTime())) {
        throw validationError('Invalid expiry date');
    }

    const isActive = data.isActive ?? true;

    if (typeof isActive !== 'boolean') {
        throw validationError('isActive must be true or false');
    }

    return {
        code,
        description,
        discountType,
        value,
        minOrderValue,
        maxDiscountAmount:
            discountType === 'PERCENTAGE'
                ? maxDiscountAmount
                : undefined,
        expiresAt,
        isActive,
    };
};

const handleError = (res, error) => {
    console.error('Admin coupon error:', error);

    if (error.code === 11000) {
        return res.status(409).json({
            success: false,
            error: 'Coupon code already exists',
        });
    }

    return res.status(error.statusCode || 500).json({
        success: false,
        error: error.statusCode
            ? error.message
            : 'Unable to complete coupon request',
    });
};

// Includes active, inactive and expired coupons.
exports.getAdminCoupons = async (req, res) => {
    try {
        const coupons = await Coupon.find()
            .sort({ createdAt: -1, _id: -1 })
            .lean();

        return res.json({
            success: true,
            count: coupons.length,
            coupons,
        });
    } catch (error) {
        return handleError(res, error);
    }
};

exports.createAdminCoupon = async (req, res) => {
    try {
        const data = validateCoupon(req.body || {});

        if (data.expiresAt <= new Date()) {
            throw validationError('Expiry must be in the future');
        }

        const coupon = await Coupon.create(data);

        return res.status(201).json({
            success: true,
            message: 'Coupon created successfully',
            coupon,
        });
    } catch (error) {
        return handleError(res, error);
    }
};

exports.updateAdminCoupon = async (req, res) => {
    try {
        const { couponId } = req.params;

        if (!validId(couponId)) {
            throw validationError('Invalid coupon ID');
        }

        const coupon = await Coupon.findById(couponId);

        if (!coupon) {
            return res.status(404).json({
                success: false,
                error: 'Coupon not found',
            });
        }

        const updates = {};
        const editableFields = [
            'code',
            'description',
            'discountType',
            'value',
            'minOrderValue',
            'maxDiscountAmount',
            'expiresAt',
            'isActive',
        ];

        for (const field of editableFields) {
            if (
                Object.prototype.hasOwnProperty.call(
                    req.body || {},
                    field
                )
            ) {
                updates[field] = req.body[field];
            }
        }

        const data = validateCoupon({
            ...coupon.toObject(),
            ...updates,
        });

        coupon.set(data);
        await coupon.save();

        return res.json({
            success: true,
            message: 'Coupon updated successfully',
            coupon,
        });
    } catch (error) {
        return handleError(res, error);
    }
};

exports.deleteAdminCoupon = async (req, res) => {
    try {
        const { couponId } = req.params;

        if (!validId(couponId)) {
            throw validationError('Invalid coupon ID');
        }

        const coupon = await Coupon.findByIdAndDelete(couponId);

        if (!coupon) {
            return res.status(404).json({
                success: false,
                error: 'Coupon not found',
            });
        }

        return res.json({
            success: true,
            message: 'Coupon deleted successfully',
        });
    } catch (error) {
        return handleError(res, error);
    }
};