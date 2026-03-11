const mongoose = require('mongoose');

async function connectDb() {
    const mongoUri = process.env.MONGO_URI;

    if(!mongoUri) {
        throw new Error("MONGO_URI is not defined in environment variables");
    }
    
    try {
        await mongoose.connect(mongoUri);
        console.log("Connected to MongoDB");
    } catch (error) {
        console.error("Error connecting to MongoDB:", error);
        process.exit(1);
    }
}

module.exports = connectDb;