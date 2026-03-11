const express = require('express');
const { 
    addAddress, 
    getAddresses, 
    getDefaultAddress, 
    updateAddress, 
    deleteAddress 
} = require('../controllers/address.controller'); // Adjust path as needed

const addressRouter = express.Router();

// All address routes require the user to be logged in
// We apply the middleware in the main router, or here:

// 1. Create a new address
addressRouter.post('/add', addAddress);

// 2. Get all addresses for the logged-in user
addressRouter.get('/all', getAddresses);

// 3. Get the default (or most recent) address for checkout
addressRouter.get('/default', getDefaultAddress);

// 4. Update an existing address
addressRouter.put('/update/:addressId', updateAddress);

// 5. Remove an address
addressRouter.delete('/delete/:addressId', deleteAddress);

module.exports = addressRouter;