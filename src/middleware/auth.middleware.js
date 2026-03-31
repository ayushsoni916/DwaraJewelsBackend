const User = require("../models/user.model");
const { verifyToken } = require("../services/jwt.service");

const requireAuth = async (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'] || req.headers['Authorization'];
        // console.log("Auth Header:", authHeader);

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization header missing or invalid' });
        }

        const token = authHeader.split(' ')[1]; // "Bearer TOKEN"

        let payload;

        try {
            payload = verifyToken(token)
        } catch (error) {
            console.error('JWT verify error', error.message);
            return res.status(401).json({ error: 'Invalid or expired token' });
        }

        // Basic sanity check
        if (!payload.sub) {
            return res.status(401).json({ error: 'Invalid token payload' });
        }

        const user = await User.findById(payload.sub);

        if (!user) {
            return res.status(401).json({ error: 'User not found for this token' });
        }

        req.user = {
            id: user._id.toString(),
            phone: user.phone,
            tokenPayload: payload,
            doc: user
        };

        next();
    } catch (error) {
        console.error('requireAuth error', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}

const optionalAuth = async (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'] || req.headers['Authorization'];

        // If no token, just proceed as a guest
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            req.user = null;
            return next();
        }

        const token = authHeader.split(' ')[1];
        try {
            const payload = verifyToken(token);
            if (payload && payload.sub) {
                // We don't necessarily need to query the DB here to save speed, 
                // just attaching the ID from the token is enough for wishlist checks.
                req.user = { id: payload.sub };
            }
        } catch (error) {
            // If token is invalid/expired, we treat them as a guest instead of erroring
            req.user = null;
        }
        next();
    } catch (error) {
        req.user = null;
        next();
    }
};

module.exports = {
    requireAuth,
    optionalAuth
};