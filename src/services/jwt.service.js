const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const ACCESS_TOKEN_EXP = process.env.JWT_ACCESS_EXP || '30d';
const SIGNUP_TOKEN_EXP = process.env.JWT_SIGNUP_EXP || '10m'; // 10 minutes for signup token

if (!JWT_SECRET) {
    throw new Error('JWT_SECRET is not set in environment variables');
}

// Access token for logged-in user
const generateAccessToken = (user) => {
    const payload = {
        sub: user._id.toString(),
        phone: user.phone,
        type: 'access'
    };
    return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXP });
};

// Short-lived token just to allow signup **after** OTP
const generateSignupToken = (phone) => {
    const payload = {
        phone,
        type: 'signup'
    };
    return jwt.sign(payload, JWT_SECRET, { expiresIn: SIGNUP_TOKEN_EXP });
};

// Generic verify (for middleware)
const verifyToken = (token) => {
    return jwt.verify(token, JWT_SECRET);
};

// Verify specifically a signup token
const verifySignupToken = (token) => {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.type !== 'signup') {
        const err = new Error('Invalid token type for signup');
        err.status = 401;
        throw err;
    }
    return payload; // { phone, type:'signup', iat, exp }
};

module.exports = {
    generateAccessToken,
    generateSignupToken,
    verifyToken,
    verifySignupToken
};