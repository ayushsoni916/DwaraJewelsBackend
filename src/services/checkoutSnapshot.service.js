const crypto = require('crypto');

const checkoutError = (message, statusCode = 400) =>
    Object.assign(new Error(message), { statusCode });

function moneyToPaise(value) {
    if (
        !['number', 'string'].includes(typeof value) ||
        (typeof value === 'string' && !value.trim())
    ) {
        throw checkoutError('Invalid price or coupon amount');
    }

    const scaled = Number(value) * 100;
    const paise = Math.round(scaled);

    if (
        !Number.isSafeInteger(paise) ||
        paise < 0 ||
        Math.abs(scaled - paise) > 0.000001
    ) {
        throw checkoutError(
            'Prices must be valid amounts with at most two decimal places'
        );
    }

    return paise;
}

function normalizeCheckoutAddress(input) {
    if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input)
    ) {
        throw checkoutError('Shipping address is required');
    }

    const text = field =>
        typeof input[field] === 'string'
            ? input[field].trim()
            : '';

    const address = {
        firstName: text('firstName'),
        lastName: text('lastName'),
        phone: ['string', 'number'].includes(typeof input.phone)
            ? String(input.phone).replace(/[\s()+-]/g, '')
            : '',
        email: text('email'),
        addressLine1: text('addressLine1'),
        addressLine2: text('addressLine2'),
        area: text('area'),
        city: text('city'),
        state: text('state'),
        pincode: ['string', 'number'].includes(typeof input.pincode)
            ? String(input.pincode).trim()
            : '',
        country: 'India',
    };

    if (
        input.country !== undefined &&
        text('country').toLowerCase() !== 'india'
    ) {
        throw checkoutError(
            'Only Indian shipping addresses are supported'
        );
    }

    if (
        address.phone.length === 12 &&
        address.phone.startsWith('91')
    ) {
        address.phone = address.phone.slice(2);
    }

    if (
        !address.firstName ||
        !address.addressLine1 ||
        !address.city ||
        !address.state ||
        !/^[6-9]\d{9}$/.test(address.phone) ||
        !/^[1-9]\d{5}$/.test(address.pincode) ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address.email) ||
        address.email.length > 254 ||
        ['firstName', 'lastName', 'city', 'state'].some(
            field => address[field].length > 100
        ) ||
        ['addressLine1', 'addressLine2', 'area'].some(
            field => address[field].length > 250
        )
    ) {
        throw checkoutError(
            'Enter a complete address with a valid mobile number, email and pincode'
        );
    }

    return address;
}

// The webhook will also use this to avoid clearing a changed cart.
function getCartSignature(cart) {
    const snapshot = {
        cartId: String(cart._id),
        updatedAt: cart.updatedAt
            ? new Date(cart.updatedAt).toISOString()
            : null,
        couponCode: String(cart.couponCode || '')
            .trim()
            .toUpperCase(),
        items: cart.items
            .map(item => ({
                id: String(item._id),
                product: String(item.product?._id || item.product),
                dimensionId: String(item.dimensionId || ''),
                quantity: item.quantity,
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
    };

    return crypto
        .createHash('sha256')
        .update(JSON.stringify(snapshot))
        .digest('hex');
}

function buildCheckoutSnapshot(cart, coupon) {
    if (!cart?.items?.length) {
        throw checkoutError('Cart is empty');
    }

    let subtotalPaise = 0;
    const quantities = new Map();

    const items = cart.items.map(item => {
        const product = item.product;
        const quantity = item.quantity;

        const dimension = product?.dimensions?.find(
            option =>
                String(option._id) === String(item.dimensionId)
        );

        if (
            !product?._id ||
            product.isActive === false ||
            !dimension
        ) {
            throw checkoutError(
                'A product or selected dimension is unavailable'
            );
        }

        if (!Number.isSafeInteger(quantity) || quantity < 1) {
            throw checkoutError('Invalid item quantity');
        }

        if (product.price?.currency !== 'INR') {
            throw checkoutError(
                'Every product in this checkout must be priced in INR'
            );
        }

        const key =
            String(product._id) + ':' + String(dimension._id);

        const required =
            (quantities.get(key) || 0) + quantity;

        if (
            !Number.isSafeInteger(required) ||
            !Number.isSafeInteger(dimension.stock) ||
            dimension.stock < required
        ) {
            throw checkoutError(
                'A selected dimension has insufficient stock',
                409
            );
        }

        quantities.set(key, required);

        const pricePaise = moneyToPaise(
            product.price.finalPrice
        );

        subtotalPaise += pricePaise * quantity;

        if (!Number.isSafeInteger(subtotalPaise)) {
            throw checkoutError('Cart total is too large');
        }

        return {
            product: product._id,
            dimensionId: dimension._id,
            quantity,
            size: dimension.size || null,
            priceAtPurchase: pricePaise / 100,
        };
    });

    const couponCode = String(cart.couponCode || '')
        .trim()
        .toUpperCase();

    let discountPaise = 0;

    if (couponCode) {
        if (
            !coupon ||
            coupon.code !== couponCode ||
            coupon.isActive !== true ||
            !(new Date(coupon.expiresAt).getTime() > Date.now())
        ) {
            throw checkoutError(
                'Your coupon is invalid or expired. Update the cart first.'
            );
        }

        if (
            subtotalPaise <
            moneyToPaise(coupon.minOrderValue ?? 0)
        ) {
            throw checkoutError(
                'Your cart no longer meets the coupon minimum order value'
            );
        }

        if (coupon.discountType === 'FLAT') {
            discountPaise = moneyToPaise(coupon.value);
        } else if (coupon.discountType === 'PERCENTAGE') {
            const percentage = coupon.value;

            if (
                typeof percentage !== 'number' ||
                !Number.isFinite(percentage) ||
                percentage <= 0 ||
                percentage > 100
            ) {
                throw checkoutError('Invalid coupon percentage');
            }

            discountPaise = Math.round(
                subtotalPaise * percentage / 100
            );

            if (coupon.maxDiscountAmount != null) {
                const cap = moneyToPaise(
                    coupon.maxDiscountAmount
                );

                // A positive cap limits the discount; 0 means no cap.
                if (cap > 0) {
                    discountPaise = Math.min(
                        discountPaise,
                        cap
                    );
                }
            }
        } else {
            throw checkoutError('Invalid coupon type');
        }

        discountPaise = Math.min(
            discountPaise,
            subtotalPaise
        );
    }

    // Preserve your existing shipping rule.
    const shippingPaise =
        subtotalPaise > 500000 ? 0 : 10000;

    const amountPaise =
        subtotalPaise - discountPaise + shippingPaise;

    if (
        !Number.isSafeInteger(amountPaise) ||
        amountPaise < 100
    ) {
        throw checkoutError(
            'Online payment total must be at least Rs. 1'
        );
    }

    return {
        items,
        couponCode,
        amountPaise,
        cartSignature: getCartSignature(cart),
        summary: {
            subtotal: subtotalPaise / 100,
            discount: discountPaise / 100,
            shipping: shippingPaise / 100,
            totalCost: amountPaise / 100,
        },
    };
}

module.exports = {
    normalizeCheckoutAddress,
    getCartSignature,
    buildCheckoutSnapshot,
};