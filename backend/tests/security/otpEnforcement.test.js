/**
 * The email code is enforced by the SERVER, not just the app.
 *
 * Before this, the app checked the code but the API accepted any valid
 * Firebase token, so someone with a Firebase sign-in could skip the code by
 * calling the API directly. Now the API only accepts tokens whose sign-in
 * (`auth_time`) was recorded when the right code was entered.
 *
 *   npx jest tests/security/otpEnforcement.test.js
 */

process.env.ENFORCE_OTP_IN_TESTS = 'true';

jest.mock('../../src/config/prisma', () => ({
  users: { findUnique: jest.fn(), update: jest.fn() },
}));
jest.mock('../../src/config/firebase', () => ({
  auth: { verifyIdToken: jest.fn() },
}));
jest.mock('../../src/services/authUserService', () => ({
  resolveUserFromFirebase: jest.fn(),
}));
jest.mock('../../src/services/otpService', () => ({
  verifyOTP: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../src/models/User', () => ({ getStats: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const jwt = require('jsonwebtoken');
const prisma = require('../../src/config/prisma');
const admin = require('../../src/config/firebase');
const { resolveUserFromFirebase } = require('../../src/services/authUserService');
const otpService = require('../../src/services/otpService');
const { authenticate, optionalAuth } = require('../../src/middleware/auth');
const { isOtpSessionVerified, recordOtpSession } = require('../../src/services/otpSession');
const AuthController = require('../../src/controllers/authController');

afterAll(() => { delete process.env.ENFORCE_OTP_IN_TESTS; });
beforeEach(() => jest.clearAllMocks());

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const USER = {
  id: 7, email: 'driver@gmail.com', role: 'FINDER', firebase_uid: 'uid-7',
  is_finder_registered: true, is_spotter_registered: false,
  otp_auth_times: [1000],
};

const req = (url = '/api/v1/bookings/my-bookings') => ({
  headers: { authorization: 'Bearer tok' },
  originalUrl: url,
});

describe('authenticate', () => {
  test('accepts a token from a sign-in that passed the code', async () => {
    admin.auth.verifyIdToken.mockResolvedValue({ uid: 'uid-7', auth_time: 1000 });
    resolveUserFromFirebase.mockResolvedValue(USER);
    const r = req(); const res = mockRes(); const next = jest.fn();
    await authenticate(r, res, next);
    expect(next).toHaveBeenCalled();
    expect(r.user.id).toBe(7);
  });

  test('rejects a fresh sign-in that never entered the code', async () => {
    admin.auth.verifyIdToken.mockResolvedValue({ uid: 'uid-7', auth_time: 2000 });
    resolveUserFromFirebase.mockResolvedValue(USER);
    const res = mockRes(); const next = jest.fn();
    await authenticate(req(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].code).toBe('OTP_REQUIRED');
  });

  test('rejects a token with no sign-in time', async () => {
    admin.auth.verifyIdToken.mockResolvedValue({ uid: 'uid-7' });
    resolveUserFromFirebase.mockResolvedValue(USER);
    const res = mockRes(); const next = jest.fn();
    await authenticate(req(), res, next);
    expect(next).not.toHaveBeenCalled();
  });

  test('logout still works before the code is entered', async () => {
    admin.auth.verifyIdToken.mockResolvedValue({ uid: 'uid-7', auth_time: 2000 });
    resolveUserFromFirebase.mockResolvedValue(USER);
    const next = jest.fn();
    await authenticate(req('/api/v1/auth/logout'), mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  test('optionalAuth treats an unverified sign-in as a guest', async () => {
    admin.auth.verifyIdToken.mockResolvedValue({ uid: 'uid-7', auth_time: 2000 });
    resolveUserFromFirebase.mockResolvedValue(USER);
    const r = req(); const next = jest.fn();
    await optionalAuth(r, mockRes(), next);
    expect(next).toHaveBeenCalled();
    expect(r.user).toBeUndefined();
  });
});

describe('otpSession', () => {
  test('keeps only the newest five sign-ins', async () => {
    prisma.users.findUnique.mockResolvedValue({ otp_auth_times: [1, 2, 3, 4, 5] });
    await recordOtpSession(7, { auth_time: 6 });
    expect(prisma.users.update).toHaveBeenCalledWith({
      where: { id: 7 }, data: { otp_auth_times: [2, 3, 4, 5, 6] },
    });
  });

  test('does not duplicate an existing sign-in', async () => {
    prisma.users.findUnique.mockResolvedValue({ otp_auth_times: [1, 2] });
    await recordOtpSession(7, { auth_time: 1 });
    expect(prisma.users.update.mock.calls[0][0].data.otp_auth_times).toEqual([2, 1]);
  });

  test('isOtpSessionVerified needs an exact match', () => {
    expect(isOtpSessionVerified(USER, { auth_time: 1000 })).toBe(true);
    expect(isOtpSessionVerified(USER, { auth_time: 999 })).toBe(false);
    expect(isOtpSessionVerified({ ...USER, otp_auth_times: undefined }, { auth_time: 1000 })).toBe(false);
  });
});

describe('verifyLoginOTP records the sign-in', () => {
  const secret = process.env.JWT_SECRET || 'jwt_default_secret_key';
  const pending = jwt.sign({ purpose: 'login_pending', email: 'driver@gmail.com', user_id: 7 }, secret);
  const body = { email: 'driver@gmail.com', code: '123456', pending_login_token: pending };

  test('right code + matching Firebase account → sign-in recorded', async () => {
    admin.auth.verifyIdToken.mockResolvedValue({ uid: 'uid-7', auth_time: 3000 });
    prisma.users.findUnique
      .mockResolvedValueOnce(USER)                          // the user
      .mockResolvedValueOnce({ otp_auth_times: [1000] });   // inside recordOtpSession
    const res = mockRes();
    await AuthController.verifyLoginOTP({ headers: { authorization: 'Bearer t' }, body }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(prisma.users.update).toHaveBeenCalledWith({
      where: { id: 7 }, data: { otp_auth_times: [1000, 3000] },
    });
    const sent = res.json.mock.calls[0][0];
    expect(sent.data.user.otp_auth_times).toBeUndefined();
    expect(sent.data.access_token).toBeUndefined();
  });

  test('no Firebase sign-in on the request → refused, code not used up', async () => {
    const res = mockRes();
    await AuthController.verifyLoginOTP({ headers: {}, body }, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(otpService.verifyOTP).not.toHaveBeenCalled();
  });

  test('code presented from a different Firebase account → refused', async () => {
    admin.auth.verifyIdToken.mockResolvedValue({ uid: 'someone-else', auth_time: 3000 });
    prisma.users.findUnique.mockResolvedValueOnce(USER);
    const res = mockRes();
    await AuthController.verifyLoginOTP({ headers: { authorization: 'Bearer t' }, body }, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(prisma.users.update).not.toHaveBeenCalled();
  });
});
