const config = require('../config/env');
const logger = require('../utils/logger');
const admin = require('../config/firebase');
const prisma = require('../config/prisma');

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

    // Skip verification for development guest mode
    if (token === 'offline_token' && config.env === 'development') {
      req.user = {
        id: 1,
        email: 'guest@parkstop.app',
        role: 'FINDER',
        full_name: 'Guest User'
      };
      return next();
    }

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
      // Find the local Postgres user by firebase_uid
      let user = await prisma.users.findUnique({
        where: { firebase_uid: decodedFirebase.uid }
      });

      // Fallback: If firebase_uid is not set but email matches, link them
      if (!user && decodedFirebase.email) {
        user = await prisma.users.findUnique({
          where: { email: decodedFirebase.email }
        });
        if (user) {
          user = await prisma.users.update({
            where: { id: user.id },
            data: { firebase_uid: decodedFirebase.uid }
          });
        }
      }

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

      req.user = {
        id: user.id,
        email: user.email,
        role: user.role,
        full_name: user.full_name || user.name,
        firebase_uid: user.firebase_uid
      };
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

    const checkRoles = allowedRoles.map(r => r.toUpperCase());
    const userRole = req.user.role ? req.user.role.toUpperCase() : '';

    if (!checkRoles.includes(userRole)) {
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

      if (token === 'offline_token' && config.env === 'development') {
        req.user = {
          id: 1,
          email: 'guest@parkstop.app',
          role: 'FINDER',
          full_name: 'Guest User'
        };
        return next();
      }

      let decodedFirebase = null;
      try {
        decodedFirebase = await admin.auth.verifyIdToken(token);
      } catch (fbError) {
        // ignore
      }

      if (decodedFirebase) {
        let user = await prisma.users.findUnique({
          where: { firebase_uid: decodedFirebase.uid }
        });

        if (!user && decodedFirebase.email) {
          user = await prisma.users.findUnique({
            where: { email: decodedFirebase.email }
          });
          if (user) {
            user = await prisma.users.update({
              where: { id: user.id },
              data: { firebase_uid: decodedFirebase.uid }
            });
          }
        }

        if (user) {
          req.user = {
            id: user.id,
            email: user.email,
            role: user.role,
            full_name: user.full_name || user.name,
            firebase_uid: user.firebase_uid
          };
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