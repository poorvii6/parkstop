/**
 * Regression test for the production gate on the test-only validation bypass.
 *
 * authValidator relaxes registration validation when NODE_ENV=test or
 * IGNORE_RATE_LIMITS=true — in that mode `otp_token` and `firebase_token`
 * become OPTIONAL. If that mode were ever reachable in production, email
 * verification would be silently disabled and anyone could register as any
 * address. The guard is one easily-deleted line, so it is pinned here.
 *
 *   npx jest tests/unit/authValidator.prodGate.test.js
 */

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

/** Load a fresh copy of the validator under a given environment. */
const loadValidator = (env) => {
  let validator;
  jest.isolateModules(() => {
    const prev = { ...process.env };
    Object.assign(process.env, env);
    validator = require('../../src/middleware/authValidator');
    process.env = prev;
  });
  return validator;
};

/** A registration body that is complete EXCEPT for proof of email ownership. */
const bodyWithoutOtp = () => ({
  email: 'someone@gmail.com',
  name: 'Test User',
  phone: '9876543210',
  role: 'FINDER',
});

describe('authValidator production gate', () => {
  it('REJECTS registration without an otp_token in production', () => {
    const { validateRegister } = loadValidator({
      NODE_ENV: 'production',
      IGNORE_RATE_LIMITS: 'false',
    });
    const res = mockRes();
    const next = jest.fn();

    validateRegister({ body: bodyWithoutOtp() }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('STILL rejects when IGNORE_RATE_LIMITS leaks into production', () => {
    // The core of this test: a stray env var must not disable email
    // verification. NODE_ENV=production has to win.
    const { validateRegister } = loadValidator({
      NODE_ENV: 'production',
      IGNORE_RATE_LIMITS: 'true',
    });
    const res = mockRes();
    const next = jest.fn();

    validateRegister({ body: bodyWithoutOtp() }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('STILL rejects when NODE_ENV is somehow reported as test in production builds', () => {
    // Belt and braces: even the literal test value cannot relax production.
    const { validateRegister } = loadValidator({
      NODE_ENV: 'production',
      IGNORE_RATE_LIMITS: 'true',
      npm_lifecycle_event: 'test',
    });
    const res = mockRes();
    const next = jest.fn();

    validateRegister({ body: bodyWithoutOtp() }, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('allows the relaxed path in a genuine test environment', () => {
    // Guard against over-correcting: the existing test suite relies on this.
    const { validateRegister } = loadValidator({
      NODE_ENV: 'test',
      IGNORE_RATE_LIMITS: 'true',
    });
    const res = mockRes();
    const next = jest.fn();

    validateRegister({ body: bodyWithoutOtp() }, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('accepts a complete production registration that DOES carry an otp_token', () => {
    const { validateRegister } = loadValidator({
      NODE_ENV: 'production',
      IGNORE_RATE_LIMITS: 'false',
    });
    const res = mockRes();
    const next = jest.fn();

    validateRegister(
      { body: { ...bodyWithoutOtp(), otp_token: 'a.b.c', firebase_token: 'x.y.z' } },
      res,
      next
    );

    expect(next).toHaveBeenCalled();
  });
});
