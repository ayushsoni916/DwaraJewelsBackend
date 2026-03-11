require('dotenv').config();
const express = require('express');
const connectDB = require('./config/db');
const router = require('./routes');

const app = express();

//connect Database
connectDB();

//Init Middleware
app.use(express.json());

app.use('/api', router)

//basic 404 for everything else
app.use((req, res) => res.status(404).json({ error: 'Not Found' }))

// centralized error handler
app.use((err, req, res, next) => {
  // log full error for server-side debugging
  console.error(err && err.stack ? err.stack : err);

  // if error already has a status, use it
  const status = err.status || 500;

  // never leak stack/details in production
  if (process.env.NODE_ENV === 'production') {
    return res.status(status).json({ error: err.message || 'Server error' });
  }

  // in development include useful error details
  return res.status(status).json({
    error: err.message || 'Server error',
    details: err && err.stack ? err.stack : undefined
  });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});

module.exports = app;