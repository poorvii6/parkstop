const express = require('express');
const { validateRegister, validateSocialLogin, validateSendOtp, validateVerifyOtp } = require('../middleware/authValidator');
const AuthController = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const loginRateLimiter = require('../middleware/loginRateLimiter');

const router = express.Router();

/**
 * OTP VERIFICATION
 */
router.post(
  '/send-otp',
  validateSendOtp,
  AuthController.sendOTP
);

router.post(
  '/verify-otp',
  validateVerifyOtp,
  AuthController.verifyOTP
);

/**
 * REGISTER
 */
router.post(
  '/register',
  validateRegister,
  AuthController.register
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
