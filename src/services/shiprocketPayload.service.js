const fail = message => {
    throw Object.assign(new Error(message), {
        statusCode: 400,
    });
};

const text = value =>
    typeof value === 'string' ? value.trim() : '';

// Validate money and use paise for calculations.
const money = (value, label) => {
    if (
        !['number', 'string'].includes(typeof value) ||
        (typeof value === 'string' && !value.trim())
    ) {
        fail(`Invalid ${label}`);
    }

    const amount = Number(value);
    const paise = Math.round(amount * 100);

    if (
        !Number.isFinite(amount) ||
        amount < 0 ||
        !Number.isSafeInteger(paise) ||
        Math.abs(amount * 100 - paise) > 0.000001
    ) {
        fail(`Invalid ${label}`);
    }

    return paise;
};

function buildShiprocketOrderPayload(order, packageDetails) {
    if (
        !order ||
        !/^[a-f\d]{24}$/i.test(String(order._id))
    ) {
        fail('Invalid order');
    }

    if (!['Pending', 'Processing'].includes(order.status)) {
        fail('Only orders awaiting dispatch can be booked');
    }

    if (
        order.paymentType !== 'Online' ||
        order.paymentStatus !== 'Paid'
    ) {
        fail('Confirmed online payment is required before shipping');
    }

    const pickupLocation = text(
        process.env.SHIPROCKET_PICKUP_LOCATION
    );

    if (!pickupLocation) {
        fail('Pickup location is not configured');
    }

    const address = order.shippingAddress || {};

    for (const field of [
        'firstName',
        'addressLine1',
        'city',
        'state',
    ]) {
        if (!text(address[field])) {
            fail(`Shipping address needs ${field}`);
        }
    }

    if (
        address.country !== undefined &&
        text(address.country).toLowerCase() !== 'india'
    ) {
        fail('Only Indian delivery addresses are supported');
    }

    const pincode = String(address.pincode ?? '').trim();

    let phone = String(address.phone ?? '')
        .replace(/[\s()+-]/g, '');

    if (phone.length === 12 && phone.startsWith('91')) {
        phone = phone.slice(2);
    }

    if (!/^[1-9]\d{5}$/.test(pincode)) {
        fail('Invalid delivery pincode');
    }

    if (!/^[6-9]\d{9}$/.test(phone)) {
        fail('Invalid delivery phone number');
    }

    const email =
        text(address.email) ||
        text(order.user?.email);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        fail('A valid customer email is required for shipping');
    }

    const measurements = {};

    for (const field of [
        'weightKg',
        'lengthCm',
        'breadthCm',
        'heightCm',
    ]) {
        const value = packageDetails?.[field];
        const number = Number(value);
        const minimum = field === 'weightKg' ? 0 : 0.5;

        if (
            !['number', 'string'].includes(typeof value) ||
            !Number.isFinite(number) ||
            number <= minimum
        ) {
            fail(`Invalid package ${field}`);
        }

        measurements[field] = number;
    }

    if (!Array.isArray(order.items) || !order.items.length) {
        fail('Order has no items');
    }

    let itemSubtotal = 0;

    const orderItems = order.items.map(item => {
        // The controller will populate these product fields.
        const product = item.product;

        if (!text(product?.title) || !text(product?.sku)) {
            fail('Populate every ordered product with title and SKU');
        }

        if (
            text(product.price?.currency).toUpperCase() !== 'INR'
        ) {
            fail('Shiprocket requires product prices in INR');
        }

        if (
            !Number.isSafeInteger(item.quantity) ||
            item.quantity < 1
        ) {
            fail('Invalid ordered quantity');
        }

        // Use the saved purchase price.
        const unitPrice = money(
            item.priceAtPurchase,
            'purchase price'
        );

        itemSubtotal += unitPrice * item.quantity;

        if (!Number.isSafeInteger(itemSubtotal)) {
            fail('Invalid order subtotal');
        }

        return {
            name: product.title,
            sku: item.dimensionId
                ? `${product.sku}-${item.dimensionId}`
                : product.sku,
            units: item.quantity,
            selling_price: unitPrice / 100,
        };
    });

    const summary = order.summary || {};

    const subtotal = money(summary.subtotal, 'subtotal');
    const discount = money(summary.discount ?? 0, 'discount');
    const shipping = money(summary.shipping, 'shipping charges');
    const total = money(summary.totalCost, 'total cost');

    if (
        subtotal !== itemSubtotal ||
        discount > subtotal ||
        total !== subtotal - discount + shipping
    ) {
        fail('Order totals do not match the saved purchase prices');
    }

    const date = new Date(
        order.orderDate || order.createdAt
    );

    if (!Number.isFinite(date.getTime())) {
        fail('Invalid order date');
    }

    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Kolkata',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        })
            .formatToParts(date)
            .map(part => [part.type, part.value])
    );

    return {
        order_id:
            order.shipping?.sourceOrderId ||
            String(order._id),

        order_date: `${parts.year}-${parts.month}-${parts.day}`,
        pickup_location: pickupLocation,

        billing_customer_name: text(address.firstName),
        billing_last_name: text(address.lastName),
        billing_address: text(address.addressLine1),

        billing_address_2: [
            text(address.addressLine2),
            text(address.area),
        ].filter(Boolean).join(', '),

        billing_city: text(address.city),
        billing_pincode: Number(pincode),
        billing_state: text(address.state),
        billing_country: 'India',
        billing_email: email,
        billing_phone: Number(phone),

        shipping_is_billing: true,
        order_items: orderItems,
        payment_method: 'Prepaid',

        shipping_charges: shipping / 100,
        total_discount: discount / 100,
        sub_total: total / 100,

        weight: measurements.weightKg,
        length: measurements.lengthCm,
        breadth: measurements.breadthCm,
        height: measurements.heightCm,
    };
}

module.exports = {
    buildShiprocketOrderPayload,
};