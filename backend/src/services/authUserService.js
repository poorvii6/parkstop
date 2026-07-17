const prisma = require('../config/prisma');
const logger = require('../utils/logger');

/**
 * Resolve the local ParkStop user for a decoded Firebase ID token.
 *
 * Resolution order:
 *   1. Match by `firebase_uid` (the stable, secure identifier).
 *   2. Fallback: link an existing account by email — but ONLY when Firebase has
 *      verified that email (`email_verified === true`).
 *
 * Why the verification gate matters: without it, anyone who creates a Firebase
 * identity using a victim's email address (via a provider that does not verify
 * emails) would be auto-linked into the victim's existing ParkStop account —
 * an account-takeover vector. Requiring a verified email closes that hole while
 * still supporting legitimate account linking (e.g. Google sign-in, which always
 * verifies the email).
 *
 * @param {object|null} decoded - decoded Firebase token (uid, email, email_verified, ...)
 * @returns {Promise<object|null>} the local user, or null if none could be resolved
 */
async function resolveUserFromFirebase(decoded) {
  if (!decoded || !decoded.uid) return null;

  // 1. Primary match: firebase_uid
  const byUid = await prisma.users.findUnique({
    where: { firebase_uid: decoded.uid },
  });
  if (byUid) return byUid;

  // 2. Email fallback — verified emails only
  if (decoded.email && decoded.email_verified === true) {
    const byEmail = await prisma.users.findUnique({
      where: { email: decoded.email },
    });
    if (byEmail) {
      logger.info(
        `Linking firebase_uid to existing user ${byEmail.id} via verified email`
      );
      return prisma.users.update({
        where: { id: byEmail.id },
        data: { firebase_uid: decoded.uid },
      });
    }
  }

  return null;
}

module.exports = { resolveUserFromFirebase };
