const rateLimit = require('express-rate-limit');

/**
 * Rate limit for /auth/social-login.
 *
 * Worth being precise about what this is defending, because it was previously
 * tuned as if it were guarding a password check. It is not: the credential is a
 * Firebase ID token that Firebase has already verified. An attacker cannot
 * brute-force anything here — they would need a valid signed token first. So
 * this is abuse/DoS protection, not anti-brute-force.
 *
 * Two changes from the original 10-per-minute rule:
 *
 *  - `skipSuccessfulRequests`: a SUCCESSFUL login no longer consumes budget.
 *    This endpoint doubles as profile sync, so it is hit on every sign-in and
 *    role switch. Counting successes meant normal use — signing in a few times
 *    while testing, or switching roles — locked the user out of their own
 *    account with a bare "Request failed with status code 429".
 *
 *  - a longer window with a higher cap, which still stops a hammering client
 *    but leaves ample headroom for a real person on a flaky connection.
 */
const loginRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  skipSuccessfulRequests: true,
  skip: () =>
    process.env.NODE_ENV === 'test' || process.env.IGNORE_RATE_LIMITS === 'true',
  message: {
    success: false,
    message:
      'Too many sign-in attempts from this device. Please wait a few minutes and try again.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

module.exports = loginRateLimiter;
