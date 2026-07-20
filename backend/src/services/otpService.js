const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');
const config = require('../config/env');
const prisma = require('../config/prisma');

// Signing key for completed verification tokens. Sourced from validated config
// rather than a local `|| 'default'` fallback: env.js already refuses to boot
// without a >=32 char JWT_SECRET, and a hardcoded fallback would let anyone who
// read this file forge an otp_token and register as any email address.
const JWT_SECRET = config.jwt.secret;

const OTP_TTL_MS = 5 * 60 * 1000;     // code is valid for 5 minutes
const RESEND_COOLDOWN_MS = 60 * 1000; // min gap between sends to one address
const MAX_VERIFY_ATTEMPTS = 5;        // guesses allowed before the code is burned

/**
 * Purge expired rows.
 *
 * Rows are otherwise only removed on successful verification, so every
 * abandoned signup would linger forever.
 */
async function sweepExpired() {
  try {
    await prisma.email_otps.deleteMany({ where: { expires_at: { lt: new Date() } } });
  } catch (err) {
    // Housekeeping only — never fail a signup because cleanup failed.
    logger.error('OTP sweep failed:', err);
  }
}

/**
 * Whether a fresh OTP may be sent to this address yet.
 *
 * Without a per-address cooldown, /auth/send-otp is an email-bombing weapon:
 * anyone can point it at a stranger's Gmail in a loop. An IP rate limit alone
 * does not stop this, since the attacker can rotate IPs while targeting one
 * victim address.
 *
 * @returns {Promise<{ allowed: boolean, retryAfterSec: number }>}
 */
async function canSendOTP(email) {
  const row = await prisma.email_otps.findUnique({ where: { email: email.toLowerCase() } });
  if (!row || Date.now() > row.expires_at.getTime()) {
    return { allowed: true, retryAfterSec: 0 };
  }

  const elapsed = Date.now() - row.issued_at.getTime();
  if (elapsed >= RESEND_COOLDOWN_MS) return { allowed: true, retryAfterSec: 0 };

  return {
    allowed: false,
    retryAfterSec: Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000),
  };
}

/**
 * Generate a secure 6-digit numeric OTP and persist it.
 *
 * Uses crypto.randomInt, not Math.random: Math.random is a non-cryptographic
 * PRNG whose output can be predicted from observed values, which would let an
 * attacker derive a victim's code without ever seeing their inbox.
 *
 * @param {string} email
 * @returns {Promise<string>} code
 */
async function generateOTP(email) {
  await sweepExpired();

  const code = crypto.randomInt(100000, 1000000).toString();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
  const key = email.toLowerCase();

  // Upsert: issuing a new code must replace any previous one for this address
  // AND reset the attempt counter, so a fresh code gets a fresh budget.
  await prisma.email_otps.upsert({
    where: { email: key },
    create: { email: key, code, issued_at: now, expires_at: expiresAt, attempts: 0 },
    update: { code, issued_at: now, expires_at: expiresAt, attempts: 0 },
  });

  // Never log the code itself in production — logs are widely readable and it
  // would hand over every signup. Dev keeps it for local testing convenience.
  if (process.env.NODE_ENV === 'production') {
    logger.info(`Gmail OTP generated for ${email} (expires in 5 mins)`);
  } else {
    logger.info(`Gmail OTP generated for ${email}: ${code} (expires in 5 mins)`);
  }
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
  const resendApiKey = process.env.RESEND_API_KEY;

  if (!resendApiKey) {
    logger.info(`\n======================================================\n` +
                `[GMAIL MOCK] Sending OTP to: ${email}\n` +
                `Subject: ParkStop Verification Code\n` +
                `Body: Your ParkStop verification code is: ${code}\n` +
                `======================================================\n`);
    return;
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${resendApiKey}`
      },
      body: JSON.stringify({
        from: 'ParkStop Support <otp@parkstop.online>',
        to: email.toLowerCase(),
        subject: 'Verify your ParkStop Account',
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
      })
    });

    const resData = await response.json();

    if (!response.ok) {
      throw new Error(resData.message || `HTTP error! Status: ${response.status}`);
    }

    logger.info(`Real Gmail verification email successfully sent to ${email} via Resend HTTPS API`);
  } catch (err) {
    logger.error(`Failed to send Gmail OTP to ${email} via Resend:`, err);
    throw err;
  }
}

/**
 * Verify OTP against the stored row.
 *
 * Enforces an attempt cap. A 6-digit code is only 900,000 possibilities; with
 * unlimited guesses inside the 5 minute window an attacker can simply grind it,
 * which would defeat email verification entirely. After MAX_VERIFY_ATTEMPTS the
 * code is burned and the user must request a new one.
 *
 * @param {string} email
 * @param {string} code
 * @returns {Promise<{ ok: boolean, reason?: 'not_found'|'expired'|'too_many_attempts'|'mismatch' }>}
 */
async function verifyOTP(email, code) {
  const key = email.toLowerCase();
  const row = await prisma.email_otps.findUnique({ where: { email: key } });

  if (!row) {
    logger.warn(`No OTP found for ${email}`);
    return { ok: false, reason: 'not_found' };
  }

  if (Date.now() > row.expires_at.getTime()) {
    logger.warn(`OTP for ${email} has expired`);
    await prisma.email_otps.delete({ where: { email: key } }).catch(() => {});
    return { ok: false, reason: 'expired' };
  }

  if (row.attempts >= MAX_VERIFY_ATTEMPTS) {
    logger.warn(`OTP for ${email} burned after ${MAX_VERIFY_ATTEMPTS} failed attempts`);
    await prisma.email_otps.delete({ where: { email: key } }).catch(() => {});
    return { ok: false, reason: 'too_many_attempts' };
  }

  // Increment atomically in the database rather than read-modify-write, so
  // concurrent guesses cannot race each other into extra free attempts.
  const updated = await prisma.email_otps.update({
    where: { email: key },
    data: { attempts: { increment: 1 } },
  });

  const codeBuffer = Buffer.from(code);
  const storedBuffer = Buffer.from(row.code);

  // timingSafeEqual throws on length mismatch, so guard first. Bailing early on
  // a wrong length leaks nothing useful: the length is fixed at 6 and already
  // enforced by the request validator.
  if (codeBuffer.length !== storedBuffer.length) {
    return { ok: false, reason: 'mismatch' };
  }

  if (crypto.timingSafeEqual(codeBuffer, storedBuffer)) {
    await prisma.email_otps.delete({ where: { email: key } }).catch(() => {});
    logger.info(`OTP verified successfully for ${email}`);
    return { ok: true };
  }

  logger.warn(`Invalid OTP attempt ${updated.attempts}/${MAX_VERIFY_ATTEMPTS} for ${email}`);
  return { ok: false, reason: 'mismatch' };
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
  canSendOTP,
  sendEmailOTP,
  verifyOTP,
  generateOTPToken,
  validateOTPToken,
  MAX_VERIFY_ATTEMPTS,
  RESEND_COOLDOWN_MS,
  OTP_TTL_MS
};
