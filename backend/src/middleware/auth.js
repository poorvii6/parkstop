const jwt = require('jsonwebtoken');
const config = require('../config/env');
const logger = require('../utils/logger');

/**
 * 🔒 Authenticate user (JWT)
 */
const authenticate = (req, res, next) => {
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
const optionalAuth = (req, res, next) => {
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