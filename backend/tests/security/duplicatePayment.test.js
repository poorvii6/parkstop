/**
 * A second real payment for a booking that is already paid.
 *
 * The money is captured into ParkStop's Razorpay account whatever we do, so the
 * only question is whether it goes back. It used to stay: the atomic claim in
 * _finalizeClaimedBooking returned null, the caller logged "already settled —
 * idempotent ack", and nothing recorded it, refunded it or told anyone.
 *
 * What is checked here is the safety around giving it back: that the ORIGINAL
 * payment is never touched, that a redelivered webhook cannot refund twice,
 * that an unverified id is never refunded, and that a failure reaches a human.
 *
 *   npx jest tests/security/duplicatePayment.test.js
 */
jest.mock('../../src/config/prisma', () => ({
  bookings: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  users: { update: jest.fn(), findMany: jest.fn() },
  payouts: { findFirst: jest.fn(), create: jest.fn() },
  $transaction: jest.fn(),
}));
jest.mock('../../src/services/payments/RazorpayAdapter', () => ({
  verifyPaymentSignature: jest.fn(),
  fetchOrder: jest.fn(),
  fetchPayment: jest.fn(),
  fetchRefunds: jest.fn(),
  capturePayment: jest.fn(),
  refund: jest.fn(),
  createOrder: jest.fn(),
  createQrCode: jest.fn(),
}));
jest.mock('../../src/services/payments/PayoutService', () => ({ processBookingPayout: jest.fn() }));
jest.mock('../../src/services/notificationService', () => ({
  sendPushNotification: jest.fn(),
  notifyBookingPaid: jest.fn(),
}));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const prisma = require('../../src/config/prisma');
const rzp = require('../../src/services/payments/RazorpayAdapter');
const Notify = require('../../src/services/notificationService');
const logger = require('../../src/utils/logger');
const PaymentService = require('../../src/services/paymentService');

const ORIGINAL = 'pay_ORIGINAL';
const DUP = 'pay_DUPLICATE';

// Booking 1, finder 7, ₹100 parking + ₹10 advance = ₹110 (13500 paise includes
// ₹25 of old dues on the order; the payment itself is ₹110 = 11000 paise).
const PAID = {
  id: 1,
  user_id: 7,
  total_price: 100,
  advance_fee: 10,
  amount_paid: 110,
  status: 'completed',
  payment_status: 'paid',
  payment_id: ORIGINAL,
  users: { id: 7, balance: 0 },
};

const DUP_PAYMENT = { id: DUP, order_id: 'order_dup', status: 'captured', amount: 11000 };
const DUP_ORDER = { id: 'order_dup', amount: 11000, notes: { booking_id: '1', user_id: '7', arrears: '0' } };
const QR_ENTITY = { notes: { booking_id: '1', arrears: '0' } };

/** Every refund call, as [paymentId, rupees]. */
const refundCalls = () => rzp.refund.mock.calls.map((c) => [c[0], c[1]]);

beforeEach(() => {
  jest.clearAllMocks();
  prisma.bookings.findUnique.mockResolvedValue(PAID);
  prisma.bookings.findFirst.mockResolvedValue(null);
  // The booking is already paid, so the atomic claim finds nothing to claim.
  prisma.bookings.updateMany.mockResolvedValue({ count: 0 });
  prisma.bookings.update.mockResolvedValue({});
  prisma.users.findMany.mockResolvedValue([{ id: 99 }]); // one admin
  rzp.verifyPaymentSignature.mockReturnValue(true);
  rzp.fetchOrder.mockResolvedValue(DUP_ORDER);
  // Nothing refunded yet on the duplicate.
  rzp.fetchPayment.mockResolvedValue({ ...DUP_PAYMENT, amount_refunded: 0 });
  rzp.fetchRefunds.mockResolvedValue([]);
  rzp.refund.mockResolvedValue('rfnd_dup_1');
  Notify.sendPushNotification.mockResolvedValue();
  Notify.notifyBookingPaid.mockResolvedValue();
});

describe('a duplicate arriving on the owner QR', () => {
  const credit = () => PaymentService.settleFromQrCredit(DUP_PAYMENT, QR_ENTITY);

  test('is refunded in full, once', async () => {
    const r = await credit();

    expect(refundCalls()).toEqual([[DUP, 110]]);
    expect(r.duplicate.refunded).toBe(true);
  });

  test('NEVER refunds the original payment', async () => {
    await credit();

    // The id on the booking paid for the parking. Refunding it would hand back
    // the real money and leave the duplicate sitting in our account.
    expect(rzp.refund).not.toHaveBeenCalledWith(ORIGINAL, expect.anything());
    expect(refundCalls().map(([id]) => id)).not.toContain(ORIGINAL);
  });

  test('tells the driver they were charged twice', async () => {
    await credit();

    expect(Notify.sendPushNotification).toHaveBeenCalledWith(7, expect.objectContaining({
      body: 'You were charged twice for booking #1. ₹110 is on its way back to your original payment method.',
      data: expect.objectContaining({ type: 'duplicate_payment_refunded', bookingId: 1 }),
    }));
  });

  test('logs both payment ids and the amount', async () => {
    await credit();

    const loud = logger.error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(loud).toMatch(/DUPLICATE PAYMENT/);
    expect(loud).toContain(DUP);
    expect(loud).toContain(ORIGINAL);
    expect(loud).toContain('110');
  });

  test('the same payment arriving again is a retry, not a duplicate', async () => {
    // Razorpay redelivers the very payment that settled the booking.
    const r = await PaymentService.settleFromQrCredit(
      { ...DUP_PAYMENT, id: ORIGINAL }, QR_ENTITY
    );

    expect(rzp.refund).not.toHaveBeenCalled();
    expect(r.duplicate.duplicate).toBe(false);
  });
});

describe('a redelivered webhook cannot refund twice', () => {
  const hook = () => PaymentService.settleFromWebhook(DUP_PAYMENT);

  test('refunds the duplicate the first time', async () => {
    await hook();
    expect(refundCalls()).toEqual([[DUP, 110]]);
  });

  test('a retry sees Razorpay has already refunded it and does not refund again', async () => {
    // amount_refunded rises as soon as a refund is CREATED, so one that timed
    // out on our side but was accepted on theirs is caught here.
    rzp.fetchPayment.mockResolvedValue({ ...DUP_PAYMENT, amount_refunded: 11000 });
    rzp.fetchRefunds.mockResolvedValue([{ id: 'rfnd_dup_1' }]);

    const r = await hook();

    expect(rzp.refund).not.toHaveBeenCalled();
    expect(r.duplicate.alreadyRefunded).toBe(true);
    expect(r.duplicate.refundId).toBe('rfnd_dup_1');
  });

  test('Razorpay is asked BEFORE refund is called, never after', async () => {
    const order = [];
    rzp.fetchPayment.mockImplementation(async () => { order.push('ask'); return { ...DUP_PAYMENT, amount_refunded: 0 }; });
    rzp.refund.mockImplementation(async () => { order.push('refund'); return 'rfnd_dup_1'; });

    await hook();

    expect(order).toEqual(['ask', 'refund']);
  });
});

describe('when the duplicate refund fails', () => {
  test('a Razorpay 4xx tells the admins and does not keep retrying', async () => {
    rzp.refund.mockRejectedValue({ statusCode: 400, error: { description: 'payment already refunded' } });

    const r = await PaymentService.settleFromWebhook(DUP_PAYMENT);

    expect(r.duplicate.needsReview).toBe(true);
    expect(r.duplicate.permanent).toBe(true);
    expect(Notify.sendPushNotification).toHaveBeenCalledWith(99, expect.objectContaining({
      title: 'Duplicate payment needs review',
      body: expect.stringContaining('payment already refunded'),
    }));
    // Acked, so Razorpay stops redelivering something that will never succeed.
    expect(r.handled).toBe(true);
  });

  test('a temporary failure is NOT acked, so the webhook redelivers and retries', async () => {
    rzp.refund.mockRejectedValue(Object.assign(new Error('socket hang up'), {}));

    await expect(PaymentService.settleFromWebhook(DUP_PAYMENT)).rejects.toThrow(/could not be refunded yet/);
  });

  test('a failure is never silently swallowed — it is logged with both ids', async () => {
    rzp.refund.mockRejectedValue({ statusCode: 400, error: { description: 'nope' } });

    await PaymentService.settleFromWebhook(DUP_PAYMENT);

    const loud = logger.error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(loud).toMatch(/DUPLICATE REFUND FAILED/);
    expect(loud).toContain(DUP);
    expect(loud).toContain(ORIGINAL);
  });

  test('a failed duplicate refund does NOT touch the booking refund lifecycle', async () => {
    // refund_status is the DRIVER's cancellation refund, and 'needs_review' is
    // terminal there — writing it would permanently block a legitimate refund
    // for this booking. Two pots of money, one column.
    rzp.refund.mockRejectedValue({ statusCode: 400, error: { description: 'nope' } });

    await PaymentService.settleFromWebhook(DUP_PAYMENT);

    const wrote = prisma.bookings.update.mock.calls
      .filter((c) => c[0]?.data?.refund_status !== undefined);
    expect(wrote).toEqual([]);
  });
});

describe('verify refunds nothing it has not verified', () => {
  const verifyDup = (o = {}) =>
    PaymentService.verifyRazorpayPayment(o.orderId ?? 'order_dup', o.paymentId ?? DUP, o.sig ?? 'sig', 1, 7);

  test('a bad signature refunds nothing', async () => {
    rzp.verifyPaymentSignature.mockReturnValue(false);

    await expect(verifyDup()).rejects.toThrow(/signature/i);
    expect(rzp.refund).not.toHaveBeenCalled();
  });

  test('an order for a different booking refunds nothing', async () => {
    rzp.fetchOrder.mockResolvedValue({ ...DUP_ORDER, notes: { booking_id: '999', user_id: '7' } });

    await expect(verifyDup()).rejects.toThrow(/not made for this booking/i);
    expect(rzp.refund).not.toHaveBeenCalled();
  });

  test('an order for a different finder refunds nothing', async () => {
    rzp.fetchOrder.mockResolvedValue({ ...DUP_ORDER, notes: { booking_id: '1', user_id: '8' } });

    await expect(verifyDup()).rejects.toThrow(/not made for this booking/i);
    expect(rzp.refund).not.toHaveBeenCalled();
  });

  test('a payment belonging to another order refunds nothing', async () => {
    rzp.fetchPayment.mockResolvedValue({ ...DUP_PAYMENT, order_id: 'order_somebody_else', amount_refunded: 0 });

    await expect(verifyDup()).rejects.toThrow(/not made for this booking/i);
    expect(rzp.refund).not.toHaveBeenCalled();
  });

  test('a payment already used for another booking refunds nothing', async () => {
    prisma.bookings.findFirst.mockResolvedValue({ id: 42 });

    await expect(verifyDup()).rejects.toThrow(/already used for another booking/i);
    expect(rzp.refund).not.toHaveBeenCalled();
  });

  test('an id that survives the WHOLE chain is refunded as a duplicate', async () => {
    const r = await verifyDup();

    expect(refundCalls()).toEqual([[DUP, 110]]);
    // The booking keeps the payment that actually settled it.
    expect(r.paymentId).toBe(ORIGINAL);
    expect(r.success).toBe(true);
  });

  test('the same payment id verifying again is an ordinary retry', async () => {
    const r = await PaymentService.verifyRazorpayPayment('order_dup', ORIGINAL, 'sig', 1, 7);

    expect(rzp.refund).not.toHaveBeenCalled();
    expect(r).toEqual({ success: true, paymentId: ORIGINAL });
  });
});
