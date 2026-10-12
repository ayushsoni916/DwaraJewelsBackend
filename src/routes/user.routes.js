const User = require('../models/user.model');

exports.getAllUsers = async (req, res) => {
    try {
        const page = Number(req.query.page ?? 1);
        const limit = Number(req.query.limit ?? 20);

        if (
            !Number.isSafeInteger(page) ||
            page < 1 ||
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > 100
        ) {
            return res.status(400).json({
                success: false,
                error: 'Page must be positive and limit must be between 1 and 100',
            });
        }

        const query = {};

        const search = typeof req.query.search === 'string'
            ? req.query.search.trim()
            : '';

        if (search) {
            const escapedSearch = search.replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&'
            );

            const regex = new RegExp(escapedSearch, 'i');

            query.$or = [
                { firstName: regex },
                { lastName: regex },
                { phone: regex },
                { email: regex },
            ];
        }

        const [users, total] = await Promise.all([
            User.find(query)
                .select(
                    '_id firstName lastName phone email gender createdAt updatedAt'
                )
                .sort({ createdAt: -1, _id: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),

            User.countDocuments(query),
        ]);

        return res.status(200).json({
            success: true,
            count: users.length,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
            hasMore: page * limit < total,
            users,
        });
    } catch (error) {
        console.error('getAllUsers error:', error);

        return res.status(500).json({
            success: false,
            error: 'Unable to fetch users',
        });
    }
};