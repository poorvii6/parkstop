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
  // register() resolves the existing account with findFirst, socialLogin with findUnique.
  users: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
}));
jest.mock('../../src/config/firebase', () => ({
  auth: { verifyIdToken: jest.fn() },
}));
jest.mock('../../src/models/User', () => ({
  getStats: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../src/services/otpService', () => ({
  generateOTP: jest.fn().mockResolvedValue('123456'),
  sendEmailOTP: jest.fn().mockResolvedValue(undefined),
  canSendOTP: jest.fn().mockResolvedValue({ allowed: true }),
  verifyOTP: jest.fn().mockResolvedValue({ ok: true }),
  generateOTPToken: jest.fn().mockReturnValue('mock-otp-token'),
  validateOTPToken: jest.fn().mockReturnValue(true),
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

/**
 * An ADMIN is never demoted by signing up again.
 *
 * Both the login and the sign-up screens post to /auth/social-login. The login
 * screen sends { email, token } with no role; the sign-up screen sends a role,
 * and the controller used to write whatever the request carried. So an admin
 * who tapped Sign Up instead of Log In was silently demoted to FINDER, found
 * the admin screen gone, and had no way back except scripts/make-admin.js.
 *
 * It matters more than an inconvenience: the weekly payout run aborts when no
 * ADMIN account exists, so demoting the only admin stops owners being paid.
 *
 * switchRole has always refused this ("An admin stays an admin while using the
 * driver or owner screens"). These two paths did not, and the disagreement is
 * what made it a trap rather than a rule.
 */
describe('an ADMIN is never demoted by a sign-up', () => {
  const ADMIN = {
    id: 7,
    email: 'admin@parkstop.test',
    full_name: 'The Admin',
    role: 'ADMIN',
    firebase_uid: 'admin-uid',
    is_finder_registered: true,
    is_spotter_registered: false,
  };

  const signUpAs = async (role) => {
    asToken(ADMIN.firebase_uid, ADMIN.email, true);
    prisma.users.findUnique.mockResolvedValue(ADMIN);
    prisma.users.update.mockImplementation(async ({ data }) => ({ ...ADMIN, ...data }));
    const res = mockRes();
    await AuthController.socialLogin(
      { body: { token: 'any-token-string', email: ADMIN.email, role } },
      res
    );
    return prisma.users.update.mock.calls[0]?.[0]?.data || {};
  };

  // These assert the ROLE THAT GETS WRITTEN, not that a warning was logged.
  // A test that only checked the log would pass with the guard ripped out.
  it('writes role ADMIN when the sign-up screen asks for FINDER', async () => {
    const data = await signUpAs('FINDER');
    expect(prisma.users.update).toHaveBeenCalled(); // not passing on an empty object
    expect(data.role).toBe('ADMIN');
  });

  it('writes role ADMIN when the sign-up screen asks for SPOTTER', async () => {
    const data = await signUpAs('SPOTTER');
    expect(data.role).toBe('ADMIN');
  });

  it('the exact case: ADMIN + sign-up as SPOTTER -> role ADMIN, owner access granted', async () => {
    // One assertion on the single update payload, so there is no way for the
    // role to be demoted in one call and corrected in another.
    const data = await signUpAs('SPOTTER');

    expect(prisma.users.update).toHaveBeenCalledTimes(1);
    expect(prisma.users.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 7 },
        data: expect.objectContaining({ role: 'ADMIN', is_spotter_registered: true }),
      })
    );
    // And nothing in that payload demotes them.
    expect(data.role).not.toBe('SPOTTER');
    expect(data.role).not.toBe('FINDER');
  });

  it('STILL grants the capability asked for — an admin may become an owner', async () => {
    // Only the role is protected. An admin signing up as an owner should gain
    // owner access, which is what makes the owner routes work for them
    // (is_spotter_registered === true in utils/roles.js).
    const data = await signUpAs('SPOTTER');
    expect(data.is_spotter_registered).toBe(true);
  });

  it('a non-admin IS still re-roled, so ordinary sign-up is unchanged', async () => {
    asToken('finder-uid', 'finder@parkstop.test', true);
    prisma.users.findUnique.mockResolvedValue({ ...ADMIN, id: 8, role: 'FINDER', firebase_uid: 'finder-uid' });
    prisma.users.update.mockImplementation(async ({ data }) => ({ ...ADMIN, ...data }));

    await AuthController.socialLogin(
      { body: { token: 'any-token-string', email: 'finder@parkstop.test', role: 'SPOTTER' } },
      mockRes()
    );

    const data = prisma.users.update.mock.calls[0][0].data;
    expect(data.role).toBe('SPOTTER');
    expect(data.is_spotter_registered).toBe(true);
  });
});

describe('an ADMIN is never demoted by /auth/register either', () => {
  // The same overwrite existed on the register path. Fixing only social-login
  // would have left the identical trap one endpoint away.
  const ADMIN = {
    id: 7,
    email: 'admin@parkstop.test',
    full_name: 'The Admin',
    name: 'The Admin',
    role: 'ADMIN',
    firebase_uid: 'admin-uid',
    is_finder_registered: true,
    is_spotter_registered: false,
  };

  const registerAs = async (role, existing) => {
    asToken(existing.firebase_uid, existing.email, true);
    prisma.users.findFirst.mockResolvedValue(existing);
    prisma.users.findUnique.mockResolvedValue(existing);
    prisma.users.update.mockImplementation(async ({ data }) => ({ ...existing, ...data }));
    const res = mockRes();
    await AuthController.register(
      { body: { email: existing.email, name: 'The Admin', phone: '9876543210', role, firebase_token: 'any' } },
      res
    );
    return prisma.users.update.mock.calls[0]?.[0]?.data || {};
  };

  it('writes role ADMIN when registering as FINDER', async () => {
    const data = await registerAs('FINDER', ADMIN);
    // The update must have HAPPENED (otherwise this passes on an empty object
    // for the wrong reason) and must say ADMIN.
    expect(prisma.users.update).toHaveBeenCalled();
    expect(data.role).toBe('ADMIN');
    expect(data.is_finder_registered).toBe(true);
  });

  it('the exact case on this path too: ADMIN + register as SPOTTER', async () => {
    const data = await registerAs('SPOTTER', ADMIN);
    expect(data.role).toBe('ADMIN');
    expect(data.is_spotter_registered).toBe(true);
  });

  it('still grants the capability', async () => {
    const data = await registerAs('SPOTTER', ADMIN);
    expect(data.is_spotter_registered).toBe(true);
  });

  it('a non-admin IS still re-roled', async () => {
    const data = await registerAs('SPOTTER', { ...ADMIN, id: 8, role: 'FINDER', firebase_uid: 'finder-uid', email: 'finder@parkstop.test' });
    expect(data.role).toBe('SPOTTER');
  });
});
