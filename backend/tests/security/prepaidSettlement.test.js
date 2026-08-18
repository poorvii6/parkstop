/**
 * Settlement under prepayment.
 *
 * Payment used to arrive only at checkout, so paying the owner the instant
 * money landed was safe. Prepaid bookings break that assumption: the money
 * arrives before the car does, and the finder can still cancel. These tests pin
 * the two things that must hold — the owner is not paid for a booking that has
 * not happened, and amount_paid records only what this booking cost.
 */
jest.mock('../../src/config/prisma', () => ({
  bookings: { findUnique: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
  users: { update: jest.fn() },
}));
jest.mock('../../src/services/payments/PayoutService', () => ({ processBookingPayout: jest.fn() }));
jest.mock('../../src/services/payments/RazorpayAdapter', () => ({
  verifyPaymentSignature: jest.fn(() => true), fetchPayment: jest.fn(), fetchOrder: jest.fn(),
}));
jest.mock('../../src/services/payments/StripeAdapter', () => ({ retrievePaymentIntent: jest.fn() }));
jest.mock('../../src/services/payments/CashfreeAdapter', () => ({}));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const prisma = require('../../src/config/prisma');
const PayoutService = require('../../src/services/payments/PayoutService');
const PaymentService = require('../../src/services/paymentService');

const settled = (status) => ({
  id: 100,
  status,
  user_id: 5,
  spotter_earning: 320,
  total_price: 400,
  advance_fee: 50,
  users: { balance: 0 },
  parking_spots: { spotter_id: 7 },
});

beforeEach(() => {
  jest.clearAllMocks();
  prisma.bookings.updateMany.mockResolvedValue({ count: 1 });
  prisma.users.update.mockResolvedValue({});
});

describe('the owner is not paid before the car arrives', () => {
  test('a prepaid booking still reserved defers the payout', async () => {
    prisma.bookings.findUnique
      .mockResolvedValueOnce({ total_price: 400, advance_fee: 50, status: 'reserved' })
      .mockResolvedValueOnce(settled('reserved'));

    await PaymentService._finalizeClaimedBooking(100, 'pay_abc');

    // Paying out here would send real money for a booking the finder can still
    // cancel — and the refund would have nothing to claw back from.
    expect(PayoutService.processBookingPayout).not.toHaveBeenCalled();
  });

  test('a completed booking pays out exactly as before', async () => {
    prisma.bookings.findUnique
      .mockResolvedValueOnce({ total_price: 400, advance_fee: 0, status: 'completed' })
      .mockResolvedValueOnce(settled('completed'));

    await PaymentService._finalizeClaimedBooking(100, 'pay_abc');

    expect(PayoutService.processBookingPayout).toHaveBeenCalledWith(100, 320, 7);
  });
});

describe('amount_paid records this booking only', () => {
  test('spot fee plus advance fee', async () => {
    prisma.bookings.findUnique
      .mockResolvedValueOnce({ total_price: 400, advance_fee: 50, status: 'reserved' })
      .mockResolvedValueOnce(settled('reserved'));

    await PaymentService._finalizeClaimedBooking(100, 'pay_abc');

    expect(prisma.bookings.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount_paid: 450 }) })
    );
  });

  test('arrears cleared in the same order are not counted as paid to it', async () => {
    // The finder owed ₹300 from an earlier unpaid booking and settles it in the
    // same Razorpay order. Counting that towards this booking would make a 70%
    // refund pay back more than this booking ever cost.
    prisma.bookings.findUnique
      .mockResolvedValueOnce({ total_price: 400, advance_fee: 0, status: 'reserved' })
      .mockResolvedValueOnce({ ...settled('reserved'), users: { balance: -300 } });

    await PaymentService._finalizeClaimedBooking(100, 'pay_abc');

    expect(prisma.bookings.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount_paid: 400 }) })
    );
    // The arrears still get cleared — that behaviour is untouched.
    expect(prisma.users.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { balance: { increment: 300 } } })
    );
  });
});
