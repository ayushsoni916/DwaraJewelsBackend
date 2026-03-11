const { default: mongoose } = require("mongoose");

const categorySchema = new mongoose.Schema({
    name: { type: String, required: true }, // "Earrings"
    image: { type: String },
    // UI shows "Explore More" sections. 
    // We can add a boolean to feature this category on the home page.
    isFeatured: { type: Boolean, default: false },
    subCategories: [{ type: String }] // ["Studs", "Jhumkas", "Hoops"]
});

module.exports = mongoose.model('Category',categorySchema)