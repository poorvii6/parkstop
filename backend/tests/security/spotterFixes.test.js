/**
 * Regression tests for the two serious spotter-side issues.
 * Real controller code, prisma + payout service mocked.
 */
jest.mock('../../src/config/prisma', () => ({
  users: { findUnique: jest.fn(), update: jest.fn() },
  withdrawals: { create: jest.fn(), update: jest.fn() },
  bookings: { findUnique: jest.fn(), update: jest.fn() },
  $transaction: jest.fn(),
}));
jest.mock('../../src/services/payments/PayoutService', () => ({
  createPayout: jest.fn(),
  processBookingPayout: jest.fn(),
}));
jest.mock('../../src/services/payments/RazorpayAdapter', () => ({
  verifyPaymentSignature: jest.fn(() => true), fetchOrder: jest.fn(), fetchPayment: jest.fn(),
}));
jest.mock('../../src/services/payments/StripeAdapter', () => ({ retrievePaymentIntent: jest.fn() }));
jest.mock('../../src/config/socket', () => ({ emitToUser: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const prisma = require('../../src/config/prisma');
const PayoutService = require('../../src/services/payments/PayoutService');
const PaymentController = require('../../src/controllers/paymentController');

const makeRes = () => ({
  statusCode: 200, body: null,
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
});

beforeEach(() => {
  jest.clearAllMocks();
  // the withdrawal transaction succeeds and returns the created row
  prisma.$transaction.mockImplementation(async (fn) =>
    fn({
      users: {
        findUnique: jest.fn().mockResolvedValue({ id: 7, balance: 500 }),
        update: jest.fn().mockResolvedValue({ balance: 200 }),
      },
      withdrawals: { create: jest.fn().mockResolvedValue({ id: 99, amount: 300 }) },
    })
  );
  prisma.withdrawals.update.mockResolvedValue({});
  prisma.users.update.mockResolvedValue({});
});

describe('withdrawal actually moves money', () => {
  test('with a linked rail, the payout is SENT (not left pending)', async () => {
    prisma.users.findUnique.mockResolvedValue({ razorpay_fund_account_id: 'fa_1', payout_mode: 'upi' });
    PayoutService.createPayout.mockResolvedValue({ id: 1, status: 'processing' });

    const req = { user: { id: 7, role: 'spotter' }, body: { methodId: 3, amount: 300 } };
    const res = makeRes();
    await PaymentController.withdrawEarnings(req, res);

    expect(PayoutService.createPayout).toHaveBeenCalledTimes(1);
    expect(PayoutService.createPayout.mock.calls[0][0]).toMatchObject({ fundAccountId: 'fa_1', amount: 300 });
    expect(res.body.success).toBe(true);
  });

  test('if the transfer throws, the money goes BACK to the wallet', async () => {
    prisma.users.findUnique.mockResolvedValue({ razorpay_fund_account_id: 'fa_1', payout_mode: 'upi' });
    PayoutService.createPayout.mockRejectedValue(new Error('rail down'));

    const req = { user: { id: 7, role: 'spotter' }, body: { methodId: 3, amount: 300 } };
    const res = makeRes();
    await PaymentController.withdrawEarnings(req, res);

    const refunded = prisma.users.update.mock.calls.some(
      (c) => c[0]?.data?.balance?.increment === 300
    );
    expect(refunded).toBe(true);          // not stranded
    expect(res.statusCode).toBe(502);
  });

  test('with no rail linked it stays pending and does NOT claim to have sent', async () => {
    prisma.users.findUnique.mockResolvedValue({ razorpay_fund_account_id: null });

    const req = { user: { id: 7, role: 'spotter' }, body: { methodId: 3, amount: 300 } };
    const res = makeRes();
    await PaymentController.withdrawEarnings(req, res);

    expect(PayoutService.createPayout).not.toHaveBeenCalled();
    expect(res.body.message).toMatch(/manual/i);
  });
});
