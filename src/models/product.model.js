const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
    // --- Basic Info ---
    title: { type: String, required: true }, // "Anes Narrow Diamond Ring..."
    sku: { type: String, required: true, unique: true }, // UI: "Number: 5672..."
    description: { type: String },
    isLuxe: { type: Boolean, default: false },
    stock: { type: Number, default: 0 },

    // --- Categorization ---
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' }, // e.g., "Rings"
    subCategory: { type: String }, // UI: The "Narrow" label under the image
    collection: { type: mongoose.Schema.Types.ObjectId, ref: 'Collection' }, // UI: "Sunshine Signature Collection"

    // --- Pricing (The "Price Distribution" Accordion) ---
    price: {
        basePrice: { type: Number }, // Raw cost
        makingCharges: { type: Number },
        tax: { type: Number },
        finalPrice: { type: Number, required: true }, // UI: $699.00
        currency: { type: String, default: 'USD' }
    },

    // --- Metal Details (UI: "Materials: Sterling Silver") ---
    metal: {
        type: { type: String, enum: ['Gold', 'Silver', 'Platinum'] },
        quality: { type: String }, // e.g., "18k", "925"
        color: { type: String }, // UI: "Rose Gold", "Yellow Gold"
        weight: { type: Number } // in grams
    },

    // --- Stone Details (The "Stone Elegance Details" Accordion) ---
    stones: [{
        type: { type: String }, // Diamond, Crystal, etc.
        shape: { type: String }, // Round, Princess
        color: { type: String }, // D-F
        clarity: { type: String }, // VVS1, VS1
        weight: { type: Number }, // UI: "Carats: 2.5"
        count: { type: Number }   // How many stones
    }],

    // --- Dimensions (The "Details" Accordion) ---
    dimensions: {
        width: { type: String },  // UI: "0.75 inches"
        length: { type: String }, // UI: "Adjustable"
        size: { type: String }    // Ring size (6, 7, 8)
    },

    // --- Media ---
    images: [{ type: String }], // Gallery
    thumbnail: { type: String }, // For listing pages
    imageDetails: [{ // New field for Admin to manage Cloudinary deletions
        url: String,
        publicId: String
    }],

    // --- Recommendation Engine ---
    tags: [{ type: String }], // ["bridal", "minimal", "gift"]
    isNewArrival: { type: Boolean, default: false }, // UI: "New Arrival" tag

    // --- Social ---
    rating: {
        average: { type: Number, default: 0 },
        count: { type: Number, default: 0 } // UI: "(20 Reviews)"
    }

}, { timestamps: true });

productSchema.index({
    title: 'text',
    tags: 'text',
    description: 'text' // Added description so users can search by keywords in the description
});

module.exports = mongoose.model('Product', productSchema);