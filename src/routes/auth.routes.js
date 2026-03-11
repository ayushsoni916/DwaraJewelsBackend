const express = require('express');
const { sendOtp, verifyOtp, signup } = require('../controllers/auth.controller');

const authRouter = express.Router();

authRouter.post('/send-otp', sendOtp);
authRouter.post('/verify-otp', verifyOtp);
authRouter.post('/signup', signup);

module.exports = authRouter;