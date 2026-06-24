const jwt = require('jsonwebtoken');
const config = require('../config/env');
const logger = require('../utils/logger');

/**
 * 🔒 Authenticate user (JWT)
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
    const decoded = jwt.verify(token, config.jwt.secret);

    req.user = {
      id: decoded.id,
      email: decoded.email,
      role: decoded.role,
      full_name: decoded.name
    };

    // Prevent stale JWT / Role Mismatch (e.g. from database re-seeds or role switching mismatches):
    // Dynamically retrieve the latest user details from the database.
    const prisma = require('../config/prisma');
    try {
      const user = await prisma.users.findUnique({
        where: { id: parseInt(decoded.id) },
        select: { role: true, email: true, full_name: true }
      });
      if (user) {
        req.user.role = user.role;
        if (user.email) req.user.email = user.email;
        if (user.full_name) req.user.full_name = user.full_name;
      } else {
        // User not found in database (e.g. database was reset / re-seeded)
        return res.status(401).json({
          success: false,
          message: 'User account not found. Please log in again.',
        });
      }
    } catch (dbErr) {
      logger.error('Error fetching user in authenticate middleware:', dbErr);
    }

    next();

  } catch (error) {
    logger.error('Authentication error:', error);

    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expired. Please login again.',
      });
    }

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token.',
      });
    }

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
 * Optional auth
 */
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const decoded = jwt.verify(token, config.jwt.secret);

      req.user = {
        id: decoded.id,
        email: decoded.email,
        role: decoded.role,
        full_name: decoded.name
      };

      const prisma = require('../config/prisma');
      try {
        const user = await prisma.users.findUnique({
          where: { id: parseInt(decoded.id) },
          select: { role: true, email: true, full_name: true }
        });
        if (user) {
          req.user.role = user.role;
          if (user.email) req.user.email = user.email;
          if (user.full_name) req.user.full_name = user.full_name;
        }
      } catch (dbErr) {
        logger.debug('Optional auth DB fetch failed:', dbErr.message);
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