const express = require('express');
const { getBanners } = require('../controllers/banner.controller');
const bannerRouter = express.Router();

bannerRouter.get('/',getBanners);

module.exports = bannerRouter;