/**
 * Unit tests for RazorpayAdapter.verifyPaymentSignature.
 *
 * This is the check that decides whether a payment is genuine, so it gets
 * tested for correctness AND for the malformed inputs an attacker would send.
 *
 * The comparison is constant-time (crypto.timingSafeEqual). `===` short-circuits
 * at the first differing character, so response timing leaks how much of the
 * signature was right — in principle recoverable one character at a time.
 *
 *   npx jest tests/unit/razorpayAdapter.signature.test.js
 */

process.env.RAZORPAY_KEY_ID = 'rzp_test_dummy';
process.env.RAZORPAY_KEY_SECRET = 'test_secret_for_signature_checks';

// virtual: the SDK is never exercised here — only the local HMAC check is —
// so the test does not depend on the package being installed.
jest.mock('razorpay', () => jest.fn().mockImplementation(() => ({})), { virtual: true });
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const crypto = require('crypto');
const adapter = require('../../src/services/payments/RazorpayAdapter');

const ORDER = 'order_ABC123';
const PAYMENT = 'pay_XYZ789';

/** The signature Razorpay would genuinely send for this order/payment pair. */
const validSignature = () =>
  crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${ORDER}|${PAYMENT}`)
    .digest('hex');

const verify = (sig) => adapter.verifyPaymentSignature(ORDER, PAYMENT, sig);

describe('verifyPaymentSignature', () => {
  it('accepts a correctly computed signature', () => {
    expect(verify(validSignature())).toBe(true);
  });

  it('rejects a signature computed with the wrong secret', () => {
    const forged = crypto
      .createHmac('sha256', 'attacker-guessed-secret')
      .update(`${ORDER}|${PAYMENT}`)
      .digest('hex');

    expect(verify(forged)).toBe(false);
  });

  it('rejects a signature for a DIFFERENT order', () => {
    // Replaying another order's signature must not settle this booking.
    const other = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`order_SOMETHING_ELSE|${PAYMENT}`)
      .digest('hex');

    expect(verify(other)).toBe(false);
  });

  it('rejects a signature differing in only the last character', () => {
    const valid = validSignature();
    const tweaked = valid.slice(0, -1) + (valid.endsWith('a') ? 'b' : 'a');

    expect(verify(tweaked)).toBe(false);
  });

  it('rejects a signature differing in only the FIRST character', () => {
    // With a short-circuiting compare this is the cheapest probe an attacker
    // makes; it must be rejected exactly like any other mismatch.
    const valid = validSignature();
    const tweaked = (valid.startsWith('a') ? 'b' : 'a') + valid.slice(1);

    expect(verify(tweaked)).toBe(false);
  });

  describe('malformed input is rejected without throwing', () => {
    // timingSafeEqual throws on length mismatch and on non-buffer input, so
    // each of these would be a 500 rather than a clean rejection if unguarded.
    it.each([
      ['a truncated signature', 'abc123'],
      ['an over-long signature', 'a'.repeat(200)],
      ['an empty string', ''],
      ['undefined', undefined],
      ['null', null],
      ['a number', 12345],
      ['an object', { evil: true }],
      ['an array', ['a', 'b']],
    ])('rejects %s', (_label, value) => {
      expect(() => verify(value)).not.toThrow();
      expect(verify(value)).toBe(false);
    });
  });
});
