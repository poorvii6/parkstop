/**
 * PaymentService.verifyRazorpayPayment — the check that marks a booking PAID.
 *
 * A booking is marked paid only when ALL of these hold:
 *   - the Razorpay signature is valid (no test/mock shortcut, in any env),
 *   - the order was created for THIS booking and THIS finder,
 *   - the payment belongs to that order and is captured for the full amount,
 *   - the order still covers the booking price,
 *   - the payment has not already settled another booking.
 * Only the old dues recorded on the order are cleared.
 *
 *   npx jest tests/unit/paymentService.verify.test.js
 */
jest.mock('../../src/config/prisma', () => ({
  bookings: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  users: { update: jest.fn() },
}));
jest.mock('../../src/services/payments/PayoutService', () => ({
  processBookingPayout: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../src/services/payments/RazorpayAdapter', () => ({
  verifyPaymentSignature: jest.fn(),
  fetchOrder: jest.fn(),
  fetchPayment: jest.fn(),
  capturePayment: jest.fn(),
  createOrder: jest.fn(),
}));
jest.mock('../../src/services/payments/StripeAdapter', () => ({}), { virtual: true });
jest.mock('../../src/services/payments/CashfreeAdapter', () => ({}), { virtual: true });
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const prisma = require('../../src/config/prisma');
const rzp = require('../../src/services/payments/RazorpayAdapter');
const PaymentService = require('../../src/services/paymentService');

// Booking 1 belongs to finder 7: ₹100 spot + ₹10 advance fee, finder owes ₹25 old dues.
const BOOKING = { id: 1, user_id: 7, total_price: 100, advance_fee: 10, status: 'active', payment_status: 'pending', users: { id: 7, balance: -25 } };
const ORDER = { id: 'order_1', amount: 13500, notes: { booking_id: '1', user_id: '7', arrears: '25' } };
const PAYMENT = { id: 'pay_1', order_id: 'order_1', status: 'captured', amount: 13500 };

const verify = (o = {}) =>
  PaymentService.verifyRazorpayPayment(o.orderId ?? 'order_1', o.paymentId ?? 'pay_1', o.sig ?? 'sig', 1, o.userId ?? 7);
const paidWrites = () => prisma.bookings.updateMany.mock.calls.filter((c) => c[0]?.data?.payment_status === 'paid');

beforeEach(() => {
  jest.clearAllMocks();
  rzp.verifyPaymentSignature.mockReturnValue(true);
  rzp.fetchOrder.mockResolvedValue(ORDER);
  rzp.fetchPayment.mockResolvedValue(PAYMENT);
  prisma.bookings.findFirst.mockResolvedValue(null);
  prisma.bookings.findUnique.mockImplementation(async () => BOOKING);
  prisma.bookings.updateMany.mockResolvedValue({ count: 1 });
  prisma.users.update.mockResolvedValue({});
});

describe('verifyRazorpayPayment', () => {
  it('settles a correct, captured payment for this booking', async () => {
    await expect(verify()).resolves.toEqual({ success: true, paymentId: 'pay_1' });
    expect(paidWrites()).toHaveLength(1);
  });

  it('rejects the old mock signature in every environment', async () => {
    rzp.verifyPaymentSignature.mockReturnValue(false);
    const saved = { ...process.env };
    for (const env of ['development', 'test', 'production']) {
      process.env.NODE_ENV = env; process.env.ALLOW_MOCK_PAYMENTS = 'true';
      await expect(verify({ sig: 'mock_upi_intent' })).rejects.toThrow(/signature verification failed/i);
    }
    process.env = saved;
    expect(paidWrites()).toHaveLength(0);
  });

  it('rejects a payment whose order was made for a DIFFERENT booking (replay)', async () => {
    rzp.fetchOrder.mockResolvedValue({ ...ORDER, notes: { ...ORDER.notes, booking_id: '99' } });
    await expect(verify()).rejects.toThrow(/not made for this booking/i);
    expect(paidWrites()).toHaveLength(0);
  });

  it('rejects an order made for a DIFFERENT finder', async () => {
    rzp.fetchOrder.mockResolvedValue({ ...ORDER, notes: { ...ORDER.notes, user_id: '8' } });
    await expect(verify()).rejects.toThrow(/not made for this booking/i);
  });

  it('rejects when the caller does not own the booking', async () => {
    await expect(verify({ userId: 8 })).rejects.toThrow(/does not belong to you/i);
  });

  it('rejects a payment that belongs to another order', async () => {
    rzp.fetchPayment.mockResolvedValue({ ...PAYMENT, order_id: 'order_2' });
    await expect(verify()).rejects.toThrow(/not made for this booking/i);
  });

  it('rejects a partial payment', async () => {
    rzp.fetchPayment.mockResolvedValue({ ...PAYMENT, amount: 100 });
    await expect(verify()).rejects.toThrow(/amount mismatch/i);
    expect(paidWrites()).toHaveLength(0);
  });

  it('rejects an order that no longer covers the booking price', async () => {
    rzp.fetchOrder.mockResolvedValue({ ...ORDER, amount: 5000 });
    rzp.fetchPayment.mockResolvedValue({ ...PAYMENT, amount: 5000 });
    await expect(verify()).rejects.toThrow(/amount changed/i);
  });

  it('captures an authorized payment, then settles', async () => {
    rzp.fetchPayment.mockResolvedValue({ ...PAYMENT, status: 'authorized' });
    rzp.capturePayment.mockResolvedValue(PAYMENT);
    await expect(verify()).resolves.toMatchObject({ success: true });
    expect(rzp.capturePayment).toHaveBeenCalledWith('pay_1', 13500);
  });

  it('rejects a failed payment', async () => {
    rzp.fetchPayment.mockResolvedValue({ ...PAYMENT, status: 'failed' });
    await expect(verify()).rejects.toThrow(/not completed/i);
  });

  it('rejects a payment already used for another booking', async () => {
    prisma.bookings.findFirst.mockResolvedValue({ id: 2 });
    await expect(verify()).rejects.toThrow(/already used/i);
    expect(paidWrites()).toHaveLength(0);
  });

  it('clears only the dues recorded on the order', async () => {
    rzp.fetchOrder.mockResolvedValue({ ...ORDER, amount: 12000, notes: { ...ORDER.notes, arrears: '10' } });
    rzp.fetchPayment.mockResolvedValue({ ...PAYMENT, amount: 12000 });
    await verify();
    expect(prisma.users.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { balance: { increment: 10 } } });
  });

  it('clears no dues when the order recorded none', async () => {
    rzp.fetchOrder.mockResolvedValue({ ...ORDER, amount: 11000, notes: { booking_id: '1', user_id: '7' } });
    rzp.fetchPayment.mockResolvedValue({ ...PAYMENT, amount: 11000 });
    await verify();
    expect(prisma.users.update).not.toHaveBeenCalled();
  });
});

describe('computePayable', () => {
  it('adds spot price, advance fee and old dues', () => {
    expect(PaymentService.computePayable({ total_price: 40, advance_fee: 10 }, { balance: -25 }))
      .toEqual({ base: 50, arrears: 25, total: 75 });
  });
  it('ignores a positive balance', () => {
    expect(PaymentService.computePayable({ total_price: 40 }, { balance: 300 }))
      .toEqual({ base: 40, arrears: 0, total: 40 });
  });
});
