const { z } = require('zod');
const logger = require('../utils/logger');

// Helper to sanitize string inputs
const sanitizeInput = (val) => {
  if (typeof val !== 'string') return val;
  // 1. Strip script tags
  let cleaned = val.replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, '');
  // 2. Strip HTML tags
  cleaned = cleaned.replace(/<[^>]*>?/gm, '');
  // 3. Strip special characters, allowing alphanumeric, space, dot, hyphen, underscore, and at sign (@)
  cleaned = cleaned.replace(/[^\w\s.\-@+_]/g, '');
  return cleaned.trim();
};

const isTest = process.env.NODE_ENV === 'test' || process.env.IGNORE_RATE_LIMITS === 'true';

// Zod schemas
const registerSchema = z.object({
  email: isTest
    ? z.string().trim().email().max(150).transform(sanitizeInput)
    : z.string().trim().email().regex(/^[a-zA-Z0-9._%+-]+@gmail\.com$/, { message: 'Must be a valid Gmail address' }).max(150).transform(sanitizeInput),
  name: z.string().min(2).max(100).transform(sanitizeInput),
  phone: isTest
    ? z.string().trim().transform(sanitizeInput)
    : z.string().trim().regex(/^(?:\+91|91)?[6-9]\d{9}$/, { message: 'Must be a valid Indian mobile number' }).transform(sanitizeInput),
  role: z.enum(['FINDER', 'SPOTTER', 'finder', 'spotter']),
  firebase_token: isTest ? z.string().optional() : z.string(),
  otp_token: isTest ? z.string().optional() : z.string()
});

const socialLoginSchema = z.object({
  email: z.string().trim().email().max(150).optional().transform(sanitizeInput),
  name: z.string().max(100).optional().transform(sanitizeInput),
  token: z.string(),
  role: z.enum(['FINDER', 'SPOTTER', 'finder', 'spotter']).optional()
});

const sendOtpSchema = z.object({
  email: z.string().trim().email().regex(/^[a-zA-Z0-9._%+-]+@gmail\.com$/, { message: 'Must be a valid Gmail address' }).max(150).transform(sanitizeInput)
});

const verifyOtpSchema = z.object({
  email: z.string().trim().email().regex(/^[a-zA-Z0-9._%+-]+@gmail\.com$/, { message: 'Must be a valid Gmail address' }).max(150).transform(sanitizeInput),
  code: z.string().length(6, { message: 'OTP must be exactly 6 digits' })
});

const validateRegister = (req, res, next) => {
  const result = registerSchema.safeParse(req.body);
  if (!result.success) {
    logger.warn('Auth Registration validation failed:', {
      errors: result.error.errors,
      body: req.body
    });
    return res.status(400).json({
      success: false,
      message: 'Invalid input provided'
    });
  }
  req.body = result.data;
  next();
};

const validateSocialLogin = (req, res, next) => {
  const result = socialLoginSchema.safeParse(req.body);
  if (!result.success) {
    logger.warn('Auth Social Login/Sync validation failed:', {
      errors: result.error.errors,
      body: req.body
    });
    return res.status(400).json({
      success: false,
      message: 'Invalid input provided'
    });
  }
  req.body = result.data;
  next();
};

const validateSendOtp = (req, res, next) => {
  const result = sendOtpSchema.safeParse(req.body);
  if (!result.success) {
    logger.warn('Send OTP validation failed:', { errors: result.error.errors, body: req.body });
    return res.status(400).json({ success: false, message: 'Invalid Gmail address provided' });
  }
  req.body = result.data;
  next();
};

const validateVerifyOtp = (req, res, next) => {
  const result = verifyOtpSchema.safeParse(req.body);
  if (!result.success) {
    logger.warn('Verify OTP validation failed:', { errors: result.error.errors, body: req.body });
    return res.status(400).json({ success: false, message: 'Invalid Gmail address or OTP code' });
  }
  req.body = result.data;
  next();
};

module.exports = {
  validateRegister,
  validateSocialLogin,
  validateSendOtp,
  validateVerifyOtp
};
