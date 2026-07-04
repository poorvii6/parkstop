const rateLimit = require('express-rate-limit');

const loginRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: {
    success: false,
    message: 'Too many requests, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

module.exports = loginRateLimiter;
