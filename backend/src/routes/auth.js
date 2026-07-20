const express = require('express');
const { validateRegister, validateSocialLogin, validateSendOtp, validateVerifyOtp } = require('../middleware/authValidator');
const AuthController = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const loginRateLimiter = require('../middleware/loginRateLimiter');
const { sendOtpRateLimiter, verifyOtpRateLimiter } = require('../middleware/otpRateLimiter');

const router = express.Router();

/**
 * OTP VERIFICATION
 */
router.post(
  '/send-otp',
  sendOtpRateLimiter,
  validateSendOtp,
  AuthController.sendOTP
);

router.post(
  '/verify-otp',
  verifyOtpRateLimiter,
  validateVerifyOtp,
  AuthController.verifyOTP
);

/**
 * REGISTER & LOGIN
 */
router.post(
  '/register',
  validateRegister,
  AuthController.register
);

router.post(
  '/login',
  AuthController.login
);

/**
 * SOCIAL LOGIN / PROFILE SYNC
 */
router.post(
  '/social-login',
  loginRateLimiter,
  validateSocialLogin,
  AuthController.socialLogin
);

/**
 * LOGOUT
 */
router.post(
  '/logout',
  authenticate,
  AuthController.logout
);

/**
 * PROFILE
 */
router.get(
  '/profile',
  authenticate,
  AuthController.getProfile
);

router.put(
  '/profile',
  authenticate,
  AuthController.updateProfile
);

router.post(
  '/switch-role',
  authenticate,
  AuthController.switchRole
);

router.post(
  '/push-token',
  authenticate,
  AuthController.updatePushToken
);

module.exports = router;
