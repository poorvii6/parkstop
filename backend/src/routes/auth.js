const express = require('express');
const { body } = require('express-validator');

const AuthController = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validator');

const router = express.Router();

/**
 * REGISTER
 */
router.post(
  '/register',
  [
    body('email').isEmail(),
    body('password')
      .isLength({ min: 8 })
      .withMessage('Password must be at least 8 characters')
      .matches(/\d/)
      .withMessage('Password must contain at least one number'),
    body('name').notEmpty(),
    body('phone').optional().isString(),
    body('role').isIn(['finder', 'spotter']),
    validate
  ],
  AuthController.register
);

/**
 * LOGIN
 */
router.post(
  '/login',
  [
    body('email').isEmail(),
    body('password').notEmpty(),
    validate
  ],
  AuthController.login
);

/**
 * SOCIAL LOGIN
 */
router.post(
  '/social-login',
  [
    body('email').isEmail(),
    body('provider').isIn(['google', 'apple']),
    validate
  ],
  AuthController.socialLogin
);

/**
 * REFRESH TOKEN
 */
router.post(
  '/refresh',
  AuthController.refreshToken
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
  '/change-password',
  authenticate,
  AuthController.changePassword
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
