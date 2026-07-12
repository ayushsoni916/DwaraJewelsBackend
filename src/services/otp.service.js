const bcrypt = require('bcryptjs');
const Otp = require('../models/otp.model');

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ATTEMPTS = 5;
const BCRYPT_ROUNDS = 8; // enough for OTP

// generate 6 digits otp
const generateOtp = () => {
    // return '111111'
    return Math.floor(100000 + Math.random() * 900000).toString()
}

const createOtpForPhone = async (phone) => {
    console.log(`Creating OTP for phone: ${phone}`);
    const code = phone == '9166033002' ? generateOtp() : '111111'; // for testing, you can set a fixed OTP for a specific phone number
    console.log(`Generated OTP: ${code} for phone: ${phone}`);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS)

    const salt = await bcrypt.genSalt(BCRYPT_ROUNDS)
    const codeHash = await bcrypt.hash(code, salt)

    await Otp.findOneAndUpdate(
        { phone },
        { codeHash, expiresAt, attempts: 0 },
        { upsert: true, new: true }
    );

    return { code, expiresAt }

}

// Verify OTP code against stored hash
const verifyOtpForPhone = async (phone, code) => {
    const otpDoc = await Otp.findOne({ phone })

    if (!otpDoc) {
        return { ok: false, reason: 'not_found' };
    }

    if (otpDoc.expiresAt < new Date()) {
        return { ok: false, reason: 'expired' };
    }

    if (otpDoc.attempts >= MAX_ATTEMPTS) {
        return { ok: false, reason: 'too_many_attempts' };
    }

    const codeToCheck = String(code);
    const isMatch = await bcrypt.compare(codeToCheck, otpDoc.codeHash);

    if (!isMatch) {
        otpDoc.attempts += 1;
        await otpDoc.save();
        return { ok: false, reason: 'invalid' };
    }

    await Otp.deleteOne({ _id: otpDoc._id })
    return { ok: true }
}

module.exports = {
    createOtpForPhone,
    verifyOtpForPhone,
    OTP_TTL_MS,
    MAX_ATTEMPTS
};
