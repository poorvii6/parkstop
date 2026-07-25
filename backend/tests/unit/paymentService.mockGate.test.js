/**
 * Unit tests for the mock-payment gate in PaymentService.verifyRazorpayPayment.
 *
 * `mock_upi_intent` marks a booking PAID with no money moving. It exists for
 * local testing, and for a long time the only thing separating it from free
 * parking in production was a NODE_ENV check — one misconfigured variable away
 * from a live hole.
 *
 * It now requires TWO independent conditions, and these tests pin the one that
 * matters: production can NEVER accept a mock signature, whatever else is set.
 *
 *   npx jest tests/unit/paymentService.mockGate.test.js
 */

jest.mock('../../src/config/prisma', () => ({
  bookings: { findUnique: jest.fn(), update: jest.fn() },
  users: { update: jest.fn() },
  $transaction: jest.fn(),
}));
jest.mock('../../src/services/payments/RazorpayAdapter', () => ({
  verifyPaymentSignature: jest.fn(() => false), // a real signature check would fail here
  fetchPayment: jest.fn(),
  createOrder: jest.fn(),
}));
jest.mock('../../src/services/payments/StripeAdapter', () => ({}), { virtual: true });
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const prisma = require('../../src/config/prisma');

const BOOKING = {
  id: 1,
  total_price: 100,
  payment_status: 'pending',
  users: { id: 7, balance: 0 },
};

const PaymentService = require('../../src/services/paymentService');

/**
 * Apply an environment for the duration of the test.
 *
 * The gate is evaluated at CALL time, not module-load time, so the environment
 * has to still be in place when the service method runs — restoring it around
 * the `require` alone would test nothing.
 */
const ORIGINAL_ENV = { ...process.env };
const setEnv = (env) => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};
afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

const load = (env) => { setEnv(env); return PaymentService; };

const attemptMockPayment = (svc) =>
  svc.verifyRazorpayPayment('order_1', 'pay_1', 'mock_upi_intent', 1);

beforeEach(() => {
  jest.clearAllMocks();
  prisma.bookings.findUnique.mockResolvedValue(BOOKING);
  prisma.bookings.update.mockResolvedValue({ ...BOOKING, payment_status: 'paid' });
  prisma.$transaction.mockImplementation(async (fn) =>
    typeof fn === 'function' ? fn(prisma) : Promise.all(fn)
  );
});

describe('mock payment gate', () => {
  describe('production can never accept a mock signature', () => {
    it('rejects a mock signature in production', async () => {
      const svc = load({ NODE_ENV: 'production', ALLOW_MOCK_PAYMENTS: 'false' });
      await expect(attemptMockPayment(svc)).rejects.toThrow(/signature verification failed/i);
    });

    it('STILL rejects when ALLOW_MOCK_PAYMENTS leaks into production', async () => {
      // The core assertion: a stray env var must not enable free parking.
      const svc = load({ NODE_ENV: 'production', ALLOW_MOCK_PAYMENTS: 'true' });
      await expect(attemptMockPayment(svc)).rejects.toThrow(/signature verification failed/i);
    });

    it('never marks the booking paid when the mock is rejected', async () => {
      const svc = load({ NODE_ENV: 'production', ALLOW_MOCK_PAYMENTS: 'true' });
      await attemptMockPayment(svc).catch(() => {});

      const paidWrites = prisma.bookings.update.mock.calls.filter(
        (c) => c[0]?.data?.payment_status === 'paid'
      );
      expect(paidWrites).toHaveLength(0);
    });
  });

  describe('non-production requires an explicit opt-in', () => {
    it('rejects a mock signature when ALLOW_MOCK_PAYMENTS is unset', async () => {
      // Merely not being production is not enough — the flag must be set.
      const svc = load({ NODE_ENV: 'development', ALLOW_MOCK_PAYMENTS: undefined });
      await expect(attemptMockPayment(svc)).rejects.toThrow(/signature verification failed/i);
    });

    it('rejects when the flag is any value other than the string "true"', async () => {
      const svc = load({ NODE_ENV: 'development', ALLOW_MOCK_PAYMENTS: '1' });
      await expect(attemptMockPayment(svc)).rejects.toThrow(/signature verification failed/i);
    });

    it('accepts a mock signature only with both conditions met', async () => {
      const svc = load({ NODE_ENV: 'development', ALLOW_MOCK_PAYMENTS: 'true' });
      await expect(attemptMockPayment(svc)).resolves.toBeDefined();
    });
  });

  describe('real signatures are unaffected', () => {
    it('still rejects a genuinely invalid signature in development', async () => {
      // The adapter mock returns false — mock-mode must not blanket-approve
      // every payment, only the specific mock_upi_intent sentinel.
      const svc = load({ NODE_ENV: 'development', ALLOW_MOCK_PAYMENTS: 'true' });
      await expect(
        svc.verifyRazorpayPayment('order_1', 'pay_1', 'a-real-but-wrong-signature', 1)
      ).rejects.toThrow(/signature verification failed/i);
    });
  });
});
