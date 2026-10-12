const prisma = require('../config/prisma');
const logger = require('../utils/logger');

/**
 * otpSession.js — server-side proof that a sign-in passed the email code.
 *
 * Firebase hands the app an ID token as soon as someone signs in (Google or
 * email/password). Before this, the email code was only checked by the app, so
 * anyone holding a valid Firebase token could call the API directly and skip
 * the code entirely.
 *
 * Every Firebase ID token carries `auth_time`: the moment of the sign-in it
 * came from. It stays the same when the token refreshes and changes on every
 * new sign-in. When the user enters the right code (or registers with a
 * verified email), we store that `auth_time` on their row. The API then only
 * accepts tokens whose `auth_time` is on the list. A fresh sign-in on another
 * phone has a different `auth_time`, so it needs its own code.
 */

const MAX_SESSIONS = 5;

/** Turned off only inside the automated tests, whose mock tokens have no auth_time. */
function otpEnforced() {
  if (process.env.NODE_ENV === 'test') return process.env.ENFORCE_OTP_IN_TESTS === 'true';
  return true;
}

function toAuthTime(decoded) {
  const t = Number(decoded && decoded.auth_time);
  return Number.isInteger(t) && t > 0 ? t : null;
}

/** True when this token comes from a sign-in that passed the email code. */
function isOtpSessionVerified(user, decoded) {
  if (!otpEnforced()) return true;
  const t = toAuthTime(decoded);
  if (!t || !user) return false;
  const list = Array.isArray(user.otp_auth_times) ? user.otp_auth_times : [];
  return list.includes(t);
}

/** Remember this sign-in as verified. Keeps the newest MAX_SESSIONS. */
async function recordOtpSession(userId, decoded) {
  const t = toAuthTime(decoded);
  if (!t) {
    logger.warn(`OTP session not recorded for user ${userId}: token has no auth_time`);
    return false;
  }
  const user = await prisma.users.findUnique({
    where: { id: userId },
    select: { otp_auth_times: true },
  });
  const current = (user && Array.isArray(user.otp_auth_times)) ? user.otp_auth_times : [];
  const next = current.filter((x) => x !== t).concat(t).slice(-MAX_SESSIONS);
  await prisma.users.update({ where: { id: userId }, data: { otp_auth_times: next } });
  return true;
}

module.exports = { otpEnforced, isOtpSessionVerified, recordOtpSession, MAX_SESSIONS };
