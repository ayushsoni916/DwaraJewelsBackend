const path = require('path');

require('dotenv').config({
    path: path.resolve(__dirname, '../../.env'),
    quiet: true,
});

const {
    shiprocketRequest,
} = require('../services/shiprocket.service');

async function testShiprocket() {
    console.log('Starting Shiprocket test...');

    const response = await shiprocketRequest(
        'GET',
        '/settings/company/pickup'
    );

    const locations = response?.data?.shipping_address;

    if (!Array.isArray(locations)) {
        throw new Error('Unexpected pickup-location response');
    }

    console.log('Shiprocket connected successfully');

    if (!locations.length) {
        console.log('No pickup locations found.');
        return;
    }

    console.table(locations.map(location => ({
        id: location.id,
        name: location.pickup_location,
        pincode: location.pin_code,
    })));
}

testShiprocket().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});