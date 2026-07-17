const { validationResult } = require('express-validator');
const logger = require('../utils/logger');

/**
 * Validate request based on express-validator rules
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);
  
  if (!errors.isEmpty()) {
    logger.warn('Validation failed:', { errors: errors.array(), path: req.path });
    
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array().map((err) => ({
        field: err.path,
        message: err.msg,
        value: err.value,
      })),
    });
  }
  
  next();
};

module.exports = validate;