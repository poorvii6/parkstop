const rateLimit = require('express-rate-limit');

// Tests and local load checks need to be able to opt out, matching the existing
// convention in authValidator.js.
const skip = () =>
  process.env.NODE_ENV === 'test' || process.env.IGNORE_RATE_LIMITS === 'true';

/**
 * Limits how many verification emails one IP can trigger.
 *
 * The service also applies a per-ADDRESS cooldown (see otpService.canSendOTP).
 * Both are needed: this one stops a single host hammering many addresses, the
 * per-address cooldown stops many hosts hammering a single victim's inbox.
 */
const sendOtpRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skip,
  message: {
    success: false,
    message: 'Too many verification emails requested. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * Limits OTP guesses per IP.
 *
 * otpService caps attempts per CODE, which is the primary brute-force defence.
 * This adds a ceiling across codes, so an attacker cannot cheaply cycle
 * request-new-code / burn-5-guesses indefinitely.
 */
const verifyOtpRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skip,
  message: {
    success: false,
    message: 'Too many verification attempts. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

module.exports = { sendOtpRateLimiter, verifyOtpRateLimiter };
