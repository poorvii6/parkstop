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
    body('password').isLength({ min: 6 }),
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
