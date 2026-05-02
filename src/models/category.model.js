const { default: mongoose } = require("mongoose");

const categorySchema = new mongoose.Schema({
    name: { type: String, required: true }, // "Earrings"
    image: {
        url: { type: String, required: true },
        publicId: { type: String, required: true }
    },
    isFeatured: { type: Boolean, default: false },
    subCategories: [{ type: String }], // ["Studs", "Jhumkas", "Hoops"]
    isLuxeCategory: { type: Boolean, default: false },
});

module.exports = mongoose.model('Category', categorySchema)