/**
 * Security reproduction tests for the SECONDARY payment endpoints.
 * These drive the REAL PaymentController code with prisma + adapters mocked
 * (same technique as the existing unit suites). They assert the SECURE
 * behaviour, so they FAIL against the current code (proving the bug) and PASS
 * once the endpoint is fixed.
 */
jest.mock('../../src/config/prisma', () => ({
  users: { update: jest.fn(), findUnique: jest.fn() },
  bookings: { update: jest.fn(), findUnique: jest.fn() },
}));
jest.mock('../../src/services/payments/RazorpayAdapter', () => ({
  verifyPaymentSignature: jest.fn(() => true), // attacker has a VALID signature for SOME order
  fetchOrder: jest.fn(),
  fetchPayment: jest.fn(),
}));
jest.mock('../../src/services/payments/StripeAdapter', () => ({
  retrievePaymentIntent: jest.fn(),
}));
jest.mock('../../src/services/payments/PayoutService', () => ({
  processBookingPayout: jest.fn(),
}));
jest.mock('../../src/config/socket', () => ({ emitToUser: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const prisma = require('../../src/config/prisma');
const Razorpay = require('../../src/services/payments/RazorpayAdapter');
const PayoutService = require('../../src/services/payments/PayoutService');
const PaymentController = require('../../src/controllers/paymentController');

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
beforeEach(() => jest.clearAllMocks());

describe('BUG 1: wallet top-up credits a client-supplied amount (inflation)', () => {
  test('paying ₹50 must NOT credit ₹10,000 to the wallet', async () => {
    // Attacker really paid a ₹50 top-up order, replays its valid signature but claims 10000.
    Razorpay.fetchOrder.mockResolvedValue({ amount: 5000, notes: { purpose: 'wallet_topup', user_id: '1' } }); // 5000 paise = ₹50
    Razorpay.fetchPayment.mockResolvedValue({ status: 'captured', amount: 5000, order_id: 'order_x' });
    const req = { user: { id: 1, role: 'finder' }, body: { order_id: 'order_x', payment_id: 'pay_x', signature: 'valid', amount: 10000 } };
    const res = makeRes();
    await PaymentController.confirmWalletTopUp(req, res);

    const credited = prisma.users.update.mock.calls
      .map(c => c[0]?.data?.balance?.increment)
      .find(v => v !== undefined);
    // Secure: either rejected, or credited at most the ₹50 actually paid.
    expect(Number(credited || 0)).toBeLessThanOrEqual(50);
  });
});

describe('BUG 2: clear-dues wipes balance on any valid signature (no amount/purpose binding)', () => {
  test('a ₹50 unrelated payment must NOT clear ₹5,000 of dues', async () => {
    prisma.users.findUnique.mockResolvedValue({ id: 7, balance: -5000 });
    Razorpay.fetchOrder.mockResolvedValue({ amount: 5000, notes: { purpose: 'wallet_topup' } }); // not a dues order, only ₹50
    Razorpay.fetchPayment.mockResolvedValue({ status: 'captured', amount: 5000 });
    const req = { user: { id: 7, role: 'spotter' }, body: { razorpay_order_id: 'order_x', razorpay_payment_id: 'pay_x', razorpay_signature: 'valid' } };
    const res = makeRes();
    await PaymentController.verifyClearDuesPayment(req, res);

    const zeroed = prisma.users.update.mock.calls.some(c => c[0]?.data?.balance === 0);
    expect(zeroed).toBe(false); // must not zero the balance for an insufficient/unrelated payment
  });
});

describe('BUG 3: stripe/verify marks paid + pays out with no ownership or gateway check', () => {
  test('a finder must NOT be able to mark someone else\'s booking paid', async () => {
    prisma.bookings.findUnique.mockResolvedValue({ id: 55, user_id: 999, spotter_earning: 80, parking_spots: { spotter_id: 8 } });
    prisma.bookings.update.mockResolvedValue({ id: 55, parking_spots: { spotter_id: 8 } });
    const req = { user: { id: 1, role: 'finder' }, body: { bookingId: 55, paymentIntentId: 'pi_fake' } };
    const res = makeRes();
    await PaymentController.verifyStripePayment(req, res);

    expect(res.statusCode).toBe(403);            // not your booking
    expect(prisma.bookings.update).not.toHaveBeenCalled();
    expect(PayoutService.processBookingPayout).not.toHaveBeenCalled();
  });
});
