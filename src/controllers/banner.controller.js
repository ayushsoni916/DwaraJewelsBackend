const getBanners = async (req, res) => {
    try {
        const banners = [
            'https://i.postimg.cc/2yXF869j/banner.png',
            'https://i.postimg.cc/t7QJ5GY3/banner2.png'
        ]
        return res.json({ success: true, banners });
    } catch (error) {
        return res.status(500).json({ error: 'Internal server error' });
    }
}

module.exports = {
    getBanners
};