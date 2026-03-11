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

module.exports = {
    requireAuth
};