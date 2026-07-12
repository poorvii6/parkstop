const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

// Local in-memory cache for Email OTP codes
const otpCache = new Map();

// JWT Secret for signing the completed verification tokens
const JWT_SECRET = process.env.JWT_SECRET || 'jwt_default_secret_key';

/**
 * Generate a secure 6-digit numeric OTP and save to cache
 * @param {string} email
 * @returns {string} code
 */
function generateOTP(email) {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes TTL

  otpCache.set(email.toLowerCase(), { code, expiresAt });
  logger.info(`Gmail OTP generated for ${email}: ${code} (Expires in 5 mins)`);
  return code;
}

/**
 * Deliver Gmail OTP to the user.
 * In development without SMTP variables, it logs to the terminal console.
 * In production or with SMTP variables, it sends a real email.
 * @param {string} email
 * @param {string} code
 */
async function sendEmailOTP(email, code) {
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = process.env.SMTP_PORT;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  const isConfigured = smtpHost && smtpPort && smtpUser && smtpPass;

  if (!isConfigured) {
    logger.info(`\n======================================================\n` +
                `[GMAIL MOCK] Sending OTP to: ${email}\n` +
                `Subject: ParkStop Verification Code\n` +
                `Body: Your ParkStop verification code is: ${code}\n` +
                `======================================================\n`);
    return;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: parseInt(smtpPort),
      secure: parseInt(smtpPort) === 465, // true for 465, false for other ports
      family: 4, // force IPv4, avoids Railway's broken IPv6 route to Gmail
      auth: {
        user: smtpUser,
        pass: smtpPass
      }
    });

    const mailOptions = {
      from: `"ParkStop Support" <${smtpUser}>`,
      to: email,
      subject: 'Verify your ParkStop Account',
      text: `Your ParkStop email verification code is: ${code}. This code is valid for 5 minutes.`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
          <h2 style="color: #3b82f6; text-align: center; margin-bottom: 24px;">ParkStop Verification</h2>
          <p style="color: #475569; font-size: 16px; line-height: 24px;">Thank you for registering with ParkStop. Please enter the following 6-digit verification code inside your mobile app to verify your Gmail account:</p>
          <div style="margin: 32px 0; text-align: center;">
            <span style="display: inline-block; font-size: 32px; font-weight: 800; color: #1e293b; letter-spacing: 4px; padding: 12px 24px; background-color: #f1f5f9; border-radius: 8px; border: 1px solid #cbd5e1;">${code}</span>
          </div>
          <p style="color: #94a3b8; font-size: 14px; text-align: center; margin-top: 24px;">This code is valid for 5 minutes. If you did not request this verification, please ignore this email.</p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    logger.info(`Real Gmail verification email successfully sent to ${email}`);
  } catch (err) {
    logger.error(`Failed to send Gmail OTP to ${email}:`, err);
    throw err;
  }
}

/**
 * Verify OTP against cached entry
 * @param {string} email
 * @param {string} code
 * @returns {boolean} success
 */
function verifyOTP(email, code) {
  const emailKey = email.toLowerCase();
  const cached = otpCache.get(emailKey);
  if (!cached) {
    logger.warn(`No OTP found in cache for ${email}`);
    return false;
  }

  if (Date.now() > cached.expiresAt) {
    logger.warn(`OTP for ${email} has expired`);
    otpCache.delete(emailKey);
    return false;
  }

  const codeBuffer = Buffer.from(code);
  const cachedBuffer = Buffer.from(cached.code);

  if (codeBuffer.length !== cachedBuffer.length) {
    return false;
  }

  const isMatch = crypto.timingSafeEqual(codeBuffer, cachedBuffer);
  if (isMatch) {
    otpCache.delete(emailKey); // Burn OTP after verification
    logger.info(`OTP verified successfully for ${email}`);
    return true;
  }

  logger.warn(`Invalid OTP verification attempt for ${email}`);
  return false;
}

/**
 * Generate a secure signed verification token
 * @param {string} email
 * @returns {string} token
 */
function generateOTPToken(email) {
  return jwt.sign(
    { email: email.toLowerCase(), verified: true },
    JWT_SECRET,
    { expiresIn: '10m' }
  );
}

/**
 * Validate the otp_token on backend registration
 * @param {string} email
 * @param {string} token
 * @returns {boolean} isValid
 */
function validateOTPToken(email, token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded.email === email.toLowerCase() && decoded.verified === true;
  } catch (err) {
    logger.warn('Failed to validate Gmail OTP token:', err.message);
    return false;
  }
}

module.exports = {
  generateOTP,
  sendEmailOTP,
  verifyOTP,
  generateOTPToken,
  validateOTPToken
};
