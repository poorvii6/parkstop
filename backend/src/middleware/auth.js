const config = require('../config/env');
const logger = require('../utils/logger');
const admin = require('../config/firebase');
const { resolveUserFromFirebase } = require('../services/authUserService');
const { hasAnyRole } = require('../utils/roles');
const { isOtpSessionVerified } = require('../services/otpSession');

// Routes a signed-in user may call before entering the email code.
// Logout must always work so a half-finished sign-in can be cleaned up.
const OTP_EXEMPT_PATHS = ['/api/v1/auth/logout'];

function toRequestUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    full_name: user.full_name || user.name,
    firebase_uid: user.firebase_uid,
    is_finder_registered: user.is_finder_registered,
    is_spotter_registered: user.is_spotter_registered,
    verification_status: user.verification_status || null
  };
}

/**
 * 🔒 Authenticate user (Firebase ID Token Only)
 */
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No token provided.',
      });
    }

    const token = authHeader.substring(7);

    let decodedFirebase = null;

    try {
      decodedFirebase = await admin.auth.verifyIdToken(token);
    } catch (fbError) {
      logger.error('Firebase token verification failed:', fbError.message);
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired token.',
      });
    }

    if (decodedFirebase) {
      // Resolve local user (uid match, or link by VERIFIED email only)
      const user = await resolveUserFromFirebase(decodedFirebase);

      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'User account not registered in ParkStop database. Please register first.',
          code: 'USER_NOT_REGISTERED',
          firebase_user: {
            uid: decodedFirebase.uid,
            email: decodedFirebase.email,
            name: decodedFirebase.name || ''
          }
        });
      }

      // The email code must have been entered for THIS sign-in. Checked on
      // the server so the code cannot be skipped by calling the API directly.
      const path = (req.originalUrl || '').split('?')[0];
      if (!OTP_EXEMPT_PATHS.includes(path) && !isOtpSessionVerified(user, decodedFirebase)) {
        return res.status(401).json({
          success: false,
          code: 'OTP_REQUIRED',
          message: 'Please sign in again and enter the code we email you.'
        });
      }

      req.user = toRequestUser(user);
    }

    next();

  } catch (error) {
    logger.error('Authentication middleware error:', error);
    return res.status(500).json({
      success: false,
      message: 'Authentication failed',
    });
  }
};

/**
 * 🔐 ROLE-BASED ACCESS CONTROL (RBAC)
 */
const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated',
      });
    }

    // Capability-based: a registered owner may use owner routes even while
    // their app is in driver mode, and vice versa. See utils/roles.js.
    if (!hasAnyRole(req.user, allowedRoles)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. Allowed: ${allowedRoles.join(', ')}`,
      });
    }

    next();
  };
};

/**
 * Optional auth (Firebase ID Token Only)
 */
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);

      let decodedFirebase = null;
      try {
        decodedFirebase = await admin.auth.verifyIdToken(token);
      } catch (fbError) {
        // ignore
      }

      if (decodedFirebase) {
        const user = await resolveUserFromFirebase(decodedFirebase);
        if (user && isOtpSessionVerified(user, decodedFirebase)) {
          req.user = toRequestUser(user);
        }
      }
    }
  } catch (error) {
    logger.debug('Optional auth failed:', error.message);
  }

  next();
};

module.exports = {
  authenticate,
  authorize,
  optionalAuth,
};