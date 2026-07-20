/**
 * Unit tests for otpService — the email-verification gate on registration.
 *
 * These focus on the ATTACK paths, because that is what this service exists to
 * resist. If any of these regress, email verification becomes decorative:
 *
 *   - unlimited guesses  -> a 6-digit code is grindable inside its 5min window
 *   - no resend cooldown -> /auth/send-otp becomes an email-bombing weapon
 *   - predictable codes  -> attacker derives the code without inbox access
 *   - unbounded cache    -> every abandoned signup leaks memory forever
 *
 * Runs with NO database and NO network.
 *   npx jest tests/unit/otpService.test.js
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'a'.repeat(40);
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test/test';
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'test';
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'test';

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const otpService = require('../../src/services/otpService');
const {
  generateOTP, canSendOTP, verifyOTP,
  generateOTPToken, validateOTPToken,
  _otpCache, MAX_VERIFY_ATTEMPTS,
} = otpService;

const EMAIL = 'victim@gmail.com';

beforeEach(() => _otpCache.clear());

describe('generateOTP', () => {
  it('issues a 6-digit numeric code', () => {
    expect(generateOTP(EMAIL)).toMatch(/^\d{6}$/);
  });

  it('never issues a code outside the 6-digit range', () => {
    // crypto.randomInt(100000, 1000000) is exclusive at the top; a fencepost
    // slip would produce a 7-digit code or a 5-digit one that fails length
    // checks downstream.
    for (let i = 0; i < 300; i++) {
      const code = generateOTP(`u${i}@gmail.com`);
      const n = Number(code);
      expect(n).toBeGreaterThanOrEqual(100000);
      expect(n).toBeLessThanOrEqual(999999);
    }
  });

  it('produces varied codes rather than a predictable sequence', () => {
    const codes = new Set();
    for (let i = 0; i < 200; i++) codes.add(generateOTP(`u${i}@gmail.com`));
    // A broken RNG (constant or low-entropy) would collide heavily here.
    expect(codes.size).toBeGreaterThan(180);
  });

  it('is case-insensitive about the address', () => {
    const code = generateOTP('MiXeD@Gmail.com');
    expect(verifyOTP('mixed@gmail.com', code).ok).toBe(true);
  });

  it('replaces any previous code for the same address', () => {
    const first = generateOTP(EMAIL);
    const second = generateOTP(EMAIL);
    expect(verifyOTP(EMAIL, first).ok).toBe(false);
    expect(verifyOTP(EMAIL, second).ok).toBe(true);
  });

  it('sweeps expired entries so the cache cannot grow without bound', () => {
    generateOTP('stale@gmail.com');
    _otpCache.get('stale@gmail.com').expiresAt = Date.now() - 1;

    generateOTP('fresh@gmail.com'); // triggers the sweep

    expect(_otpCache.has('stale@gmail.com')).toBe(false);
    expect(_otpCache.has('fresh@gmail.com')).toBe(true);
  });
});

describe('verifyOTP', () => {
  it('accepts the correct code', () => {
    const code = generateOTP(EMAIL);
    expect(verifyOTP(EMAIL, code)).toEqual({ ok: true });
  });

  it('burns the code after a successful verification (no replay)', () => {
    const code = generateOTP(EMAIL);
    expect(verifyOTP(EMAIL, code).ok).toBe(true);
    expect(verifyOTP(EMAIL, code)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('rejects a wrong code', () => {
    const code = generateOTP(EMAIL);
    const wrong = code === '111111' ? '222222' : '111111';
    expect(verifyOTP(EMAIL, wrong)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects when no code was ever issued', () => {
    expect(verifyOTP('nobody@gmail.com', '123456')).toEqual({
      ok: false, reason: 'not_found',
    });
  });

  it('rejects an expired code and drops it', () => {
    const code = generateOTP(EMAIL);
    _otpCache.get(EMAIL).expiresAt = Date.now() - 1;

    expect(verifyOTP(EMAIL, code)).toEqual({ ok: false, reason: 'expired' });
    expect(_otpCache.has(EMAIL)).toBe(false);
  });

  it('rejects a wrong-length code without throwing', () => {
    // crypto.timingSafeEqual throws on length mismatch; an unguarded call here
    // would surface as a 500 instead of a clean rejection.
    generateOTP(EMAIL);
    expect(() => verifyOTP(EMAIL, '123')).not.toThrow();
    expect(verifyOTP(EMAIL, '123').ok).toBe(false);
  });

  describe('brute-force resistance', () => {
    it(`burns the code after ${MAX_VERIFY_ATTEMPTS} wrong guesses`, () => {
      const code = generateOTP(EMAIL);
      const wrong = code === '111111' ? '222222' : '111111';

      for (let i = 0; i < MAX_VERIFY_ATTEMPTS; i++) {
        expect(verifyOTP(EMAIL, wrong).reason).toBe('mismatch');
      }

      expect(verifyOTP(EMAIL, wrong)).toEqual({
        ok: false, reason: 'too_many_attempts',
      });
      expect(_otpCache.has(EMAIL)).toBe(false);
    });

    it('refuses the CORRECT code once the attempt budget is spent', () => {
      // The critical case: an attacker who exhausts the budget must not be
      // rescued by finally landing on the right code.
      const code = generateOTP(EMAIL);
      const wrong = code === '111111' ? '222222' : '111111';

      for (let i = 0; i < MAX_VERIFY_ATTEMPTS; i++) verifyOTP(EMAIL, wrong);

      expect(verifyOTP(EMAIL, code).ok).toBe(false);
    });

    it('gives a fresh attempt budget to a newly issued code', () => {
      const first = generateOTP(EMAIL);
      const wrong = first === '111111' ? '222222' : '111111';
      for (let i = 0; i < MAX_VERIFY_ATTEMPTS; i++) verifyOTP(EMAIL, wrong);

      const second = generateOTP(EMAIL);
      expect(verifyOTP(EMAIL, second).ok).toBe(true);
    });
  });
});

describe('canSendOTP (resend cooldown)', () => {
  it('allows the first send to an address', () => {
    expect(canSendOTP(EMAIL)).toEqual({ allowed: true, retryAfterSec: 0 });
  });

  it('blocks an immediate resend and reports how long to wait', () => {
    generateOTP(EMAIL);
    const gate = canSendOTP(EMAIL);

    expect(gate.allowed).toBe(false);
    expect(gate.retryAfterSec).toBeGreaterThan(0);
    expect(gate.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it('allows a resend once the cooldown has elapsed', () => {
    generateOTP(EMAIL);
    _otpCache.get(EMAIL).issuedAt = Date.now() - 61 * 1000;

    expect(canSendOTP(EMAIL).allowed).toBe(true);
  });

  it('allows a resend once the previous code has expired', () => {
    generateOTP(EMAIL);
    _otpCache.get(EMAIL).expiresAt = Date.now() - 1;

    expect(canSendOTP(EMAIL).allowed).toBe(true);
  });

  it('does not let one address block another', () => {
    generateOTP(EMAIL);
    expect(canSendOTP('someone-else@gmail.com').allowed).toBe(true);
  });
});

describe('otp_token', () => {
  it('round-trips for the address it was issued to', () => {
    expect(validateOTPToken(EMAIL, generateOTPToken(EMAIL))).toBe(true);
  });

  it('is not valid for a DIFFERENT address', () => {
    // Otherwise a user could verify their own inbox and then register as
    // anyone, which would defeat the entire purpose of the check.
    const token = generateOTPToken('attacker@gmail.com');
    expect(validateOTPToken('victim@gmail.com', token)).toBe(false);
  });

  it('matches addresses case-insensitively', () => {
    expect(validateOTPToken('USER@Gmail.com', generateOTPToken('user@gmail.com'))).toBe(true);
  });

  it('rejects a garbage token', () => {
    expect(validateOTPToken(EMAIL, 'not-a-jwt')).toBe(false);
  });

  it('rejects a token signed with the wrong key', () => {
    const jwt = require('jsonwebtoken');
    const forged = jwt.sign({ email: EMAIL, verified: true }, 'wrong-secret-'.repeat(3));
    expect(validateOTPToken(EMAIL, forged)).toBe(false);
  });

  it('rejects a token that does not assert verification', () => {
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ email: EMAIL, verified: false }, process.env.JWT_SECRET);
    expect(validateOTPToken(EMAIL, token)).toBe(false);
  });

  it('rejects an expired token', () => {
    const jwt = require('jsonwebtoken');
    const expired = jwt.sign(
      { email: EMAIL, verified: true },
      process.env.JWT_SECRET,
      { expiresIn: '-1s' }
    );
    expect(validateOTPToken(EMAIL, expired)).toBe(false);
  });
});
