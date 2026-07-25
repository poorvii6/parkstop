/**
 * Unit tests for AuthController.socialLogin account resolution.
 *
 * THE INVARIANT: a Firebase identity may only be adopted into an EXISTING
 * ParkStop account when Firebase has verified the caller controls that email.
 *
 * Without that gate, anyone able to mint a Firebase identity carrying a
 * victim's address (an email/password signup that was never verified) would be
 * silently linked into the victim's account — inheriting their bookings,
 * wallet balance and payout details.
 *
 * The equivalent gate in authUserService is already tested; this covers the
 * DUPLICATE resolution logic that lives in socialLogin itself, which is the
 * path an attacker would actually hit (the login endpoint).
 *
 *   npx jest tests/unit/authController.socialLogin.test.js
 */

jest.mock('../../src/config/prisma', () => ({
  users: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
}));
jest.mock('../../src/config/firebase', () => ({
  auth: { verifyIdToken: jest.fn() },
}));
jest.mock('../../src/models/User', () => ({
  getStats: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const prisma = require('../../src/config/prisma');
const admin = require('../../src/config/firebase');
const AuthController = require('../../src/controllers/authController');

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const VICTIM = {
  id: 42,
  email: 'victim@gmail.com',
  full_name: 'Victim',
  role: 'FINDER',
  firebase_uid: 'victim-original-uid',
  balance: 5000,
};

/** Simulate the token Firebase hands back for a given identity. */
const asToken = (uid, email, emailVerified) => {
  admin.auth.verifyIdToken.mockResolvedValue({
    uid,
    email,
    email_verified: emailVerified,
    name: 'Whoever',
  });
};

const req = () => ({ body: { token: 'any-token-string' } });

beforeEach(() => {
  jest.clearAllMocks();
  prisma.users.update.mockImplementation(async ({ data }) => ({ ...VICTIM, ...data }));
  prisma.users.create.mockImplementation(async ({ data }) => ({ id: 99, ...data }));
});

describe('socialLogin account resolution', () => {
  describe('account takeover resistance', () => {
    it('REFUSES to link an unverified email to an existing account', async () => {
      // The attack: a fresh Firebase identity carrying the victim's address,
      // unverified. It must not be adopted into the victim's account.
      asToken('attacker-new-uid', VICTIM.email, false);
      prisma.users.findUnique
        .mockResolvedValueOnce(null)    // no match on attacker's uid
        .mockResolvedValueOnce(VICTIM); // but the email is taken

      const res = mockRes();
      await AuthController.socialLogin(req(), res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json.mock.calls[0][0].code).toBe('EMAIL_NOT_VERIFIED');
      // The critical assertion: the victim's row is never rewritten.
      expect(prisma.users.update).not.toHaveBeenCalled();
    });

    it('does not fall through and create a duplicate account', async () => {
      // Guards the specific regression of "just remove the link": creation
      // would hit the unique-email constraint and surface a raw Prisma error.
      asToken('attacker-new-uid', VICTIM.email, false);
      prisma.users.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(VICTIM);

      await AuthController.socialLogin(req(), mockRes());

      expect(prisma.users.create).not.toHaveBeenCalled();
    });

    it('treats a missing email_verified claim as unverified', async () => {
      // Absent must not be truthy-adjacent — the check is === true.
      asToken('attacker-new-uid', VICTIM.email, undefined);
      prisma.users.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(VICTIM);

      const res = mockRes();
      await AuthController.socialLogin(req(), res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(prisma.users.update).not.toHaveBeenCalled();
    });
  });

  describe('legitimate sign-in still works', () => {
    it('matches an existing user by firebase_uid regardless of verification', async () => {
      // Email/password users have email_verified=false but always match on uid,
      // so tightening the email fallback must not lock them out.
      asToken(VICTIM.firebase_uid, VICTIM.email, false);
      prisma.users.findUnique.mockResolvedValueOnce(VICTIM);

      const res = mockRes();
      await AuthController.socialLogin(req(), res);

      expect(res.status).not.toHaveBeenCalledWith(409);
      expect(res.json.mock.calls[0][0].success).toBe(true);
    });

    it('links a VERIFIED email to an existing account (Google sign-in)', async () => {
      asToken('google-uid', VICTIM.email, true);
      prisma.users.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(VICTIM);

      const res = mockRes();
      await AuthController.socialLogin(req(), res);

      expect(res.status).not.toHaveBeenCalledWith(409);
      expect(prisma.users.update).toHaveBeenCalled();
      expect(prisma.users.update.mock.calls[0][0].data.firebase_uid).toBe('google-uid');
    });

    it('creates a new account when the email is genuinely unseen', async () => {
      asToken('brand-new-uid', 'newcomer@gmail.com', true);
      prisma.users.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      const res = mockRes();
      await AuthController.socialLogin(req(), res);

      expect(prisma.users.create).toHaveBeenCalled();
      expect(res.json.mock.calls[0][0].success).toBe(true);
    });
  });

  describe('error handling', () => {
    it('rejects a request with no token', async () => {
      const res = mockRes();
      await AuthController.socialLogin({ body: {} }, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('rejects an unverifiable Firebase token', async () => {
      admin.auth.verifyIdToken.mockRejectedValue(new Error('bad token'));

      const res = mockRes();
      await AuthController.socialLogin(req(), res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('does not leak internal error detail to the client', async () => {
      asToken('some-uid', 'x@gmail.com', true);
      prisma.users.findUnique.mockRejectedValue(
        new Error('Unique constraint failed on the fields: (`email`)')
      );

      const res = mockRes();
      await AuthController.socialLogin(req(), res);

      expect(res.status).toHaveBeenCalledWith(500);
      const body = JSON.stringify(res.json.mock.calls[0][0]);
      expect(body).not.toMatch(/constraint/i);
      expect(body).not.toMatch(/email`/);
    });
  });
});
