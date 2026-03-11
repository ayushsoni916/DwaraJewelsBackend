const User = require("../models/user.model");
const { generateAccessToken, generateSignupToken, verifySignupToken } = require("../services/jwt.service");
const { createOtpForPhone, verifyOtpForPhone } = require("../services/otp.service");

const sendOtp = async (req, res) => {
    try {
        const { phone } = req.body;

        if (!phone)
            return res.status(400).json({ message: "Phone number is required" });

        const { code, expiresAt } = await createOtpForPhone(phone)

        // Here you'd call your SMS provider. For now we log in dev:
        console.log(`DEV OTP for ${phone}: ${code}, expiresAt=${expiresAt.toISOString()}`);

        return res.json({
            success: true,
            message: 'OTP sent successfully',
        })
    } catch (error) {
        console.log('sendOtp error', error)
        return res.status(500).json({ error: 'Internal server error' });
    }
}

const verifyOtp = async (req, res) => {
    try {
        const { phone, code } = req.body;

        if (!phone || !code) {
            return res.status(400).json({ error: 'phone and code are required' });
        }

        const result = await verifyOtpForPhone(phone, code)

        if (!result.ok) {
            const reasonMap = {
                not_found: { status: 400, msg: 'OTP not found or already used' },
                expired: { status: 400, msg: 'OTP expired' },
                invalid: { status: 400, msg: 'Invalid OTP' },
                too_many_attempts: { status: 429, msg: 'Too many invalid attempts' }
            };

            const info = reasonMap[result.reason] || { status: 400, msg: 'OTP verification failed' };
            return res.status(info.status).json({ error: info.msg, reason: result.reason });
        }

        const user = await User.findOne({ phone })

        if (user) {
            const token = generateAccessToken(user)

            return res.json({
                success: true,
                isNewUser: false,
                token,
                user
            })
        }

        const signupToken = generateSignupToken(phone);

        return res.json({
            success: true,
            isNewUser: true,
            signupToken
        });
    } catch (error) {
        console.error('verifyOtp error', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}

const signup = async (req, res) => {
    try {
        const { signupToken, firstName, lastName, email, gender } = req.body;

        // console.log(req.body)

        if (!signupToken) {
            return res.status(400).json({ error: 'signupToken is required' });
        }

        let payload;
        try {
            payload = verifySignupToken(signupToken)
        } catch (error) {
            console.error('verifySignupToken error', error.message);
            return res.status(401).json({ error: 'Invalid or expired signup token' });
        }

        const phone = payload.phone;
        if (!phone) {
            return res.status(400).json({ error: 'Invalid signup token payload' });
        }

        const existing = await User.findOne({ phone })
        if (existing)
            return res.status(400).json({ error: 'User already exists' })

        const user = await User.create({
            phone,
            firstName: firstName || "",
            lastName: lastName || "",
            email: email || "",
            gender,
        });

        // 🔑 FETCH FRESH USER (WITH DEFAULTS)
        const savedUser = await User.findById(user._id).lean();

        const token = generateAccessToken(user);

        return res.status(201).json({
            success: true,
            isNewUser: false,
            token,
            user: savedUser
        })
    } catch (error) {
        console.error('signup error', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}

module.exports = {
    sendOtp,
    verifyOtp,
    signup
};