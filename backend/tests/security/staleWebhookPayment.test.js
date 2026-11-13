/**
 * A payment that no longer covers the booking it was created for.
 *
 * Matching a payment against its own order proves the payment is genuine. It
 * says nothing about whether the price has moved since. A driver who overstays
 * has total_price raised by complete(), which also reopens payment_status so
 * the difference can be collected — and an older payment for the original,
 * smaller amount matches its order perfectly while being hundreds of rupees
 * short of the bill.
 *
 * The QR path and verify have always compared against computePayable. The
 * webhook did not, which made it the only door a stale payment could walk
 * through: the booking was marked fully paid, the driver's remaining debt
 * erased, and the owner credited on money that never arrived.
 *
 *   npx jest tests/security/staleWebhookPayment.test.js
 */
jest.mock('../../src/config/prisma', () => ({
  bookings: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  users: { update: jest.fn(), findMany: jest.fn() },
}));
jest.mock('../../src/services/payments/RazorpayAdapter', () => ({
  verifyPaymentSignature: jest.fn(), fetchOrder: jest.fn(), fetchPayment: jest.fn(),
  fetchRefunds: jest.fn(), capturePayment: jest.fn(), refund: jest.fn(), createOrder: jest.fn(),
}));
jest.mock('../../src/services/payments/PayoutService', () => ({ processBookingPayout: jest.fn() }));
jest.mock('../../src/services/notificationService', () => ({
  sendPushNotification: jest.fn(), notifyBookingPaid: jest.fn(),
}));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const prisma = require('../../src/config/prisma');
const rzp = require('../../src/services/payments/RazorpayAdapter');
const PayoutService = require('../../src/services/payments/PayoutService');
const PaymentService = require('../../src/services/paymentService');

/** Booked 1 hour at ₹400 + ₹50 advance, then overstayed: repriced to ₹1200. */
const REPRICED = {
  id: 1, user_id: 7,
  total_price: 1200, advance_fee: 50,
  amount_paid: 0,                 // nothing collected yet
  spotter_earning: 960,
  status: 'completed',
  payment_status: 'pending',      // complete() reopened it for the difference
  payment_id: null,
  users: { id: 7, balance: 0 },
  parking_spots: { spotter_id: 3, location_type: 'urban' },
};

const STALE_ORDER = { id: 'order_old', amount: 45000, notes: { booking_id: '1', user_id: '7', arrears: '0' } };
const STALE_PAYMENT = { id: 'pay_old', order_id: 'order_old', status: 'captured', amount: 45000 };

const settleWrites = () =>
  prisma.bookings.updateMany.mock.calls.filter((c) => c[0]?.data?.payment_status === 'paid');

beforeEach(() => {
  jest.clearAllMocks();
  prisma.bookings.findUnique.mockResolvedValue(REPRICED);
  prisma.bookings.findFirst.mockResolvedValue(null);
  prisma.bookings.updateMany.mockResolvedValue({ count: 1 });
  prisma.users.findMany.mockResolvedValue([]);
  rzp.verifyPaymentSignature.mockReturnValue(true);
  rzp.fetchOrder.mockResolvedValue(STALE_ORDER);
  rzp.fetchPayment.mockResolvedValue({ ...STALE_PAYMENT, amount_refunded: 0 });
});

describe('the webhook refuses a payment that no longer covers the booking', () => {
  test('a stale payment is rejected, not settled', async () => {
    await expect(PaymentService.settleFromWebhook(STALE_PAYMENT))
      .rejects.toThrow(/no longer covers the booking/i);

    // Nothing was marked paid, so the driver still owes the difference.
    expect(settleWrites()).toEqual([]);
  });

  test('the owner is not credited on money that never arrived', async () => {
    await expect(PaymentService.settleFromWebhook(STALE_PAYMENT)).rejects.toThrow();
    expect(PayoutService.processBookingPayout).not.toHaveBeenCalled();
  });

  test('the same stale payment is refused by the QR path too', async () => {
    await expect(
      PaymentService.settleFromQrCredit(STALE_PAYMENT, { notes: { booking_id: '1', arrears: '0' } })
    ).rejects.toThrow(/underpaid/i);
  });

  test('and by verify', async () => {
    await expect(
      PaymentService.verifyRazorpayPayment('order_old', 'pay_old', 'sig', 1, 7)
    ).rejects.toThrow(/amount changed/i);
  });
});

describe('a payment that DOES cover the booking still settles', () => {
  const GOOD_ORDER = { id: 'order_new', amount: 125000, notes: { booking_id: '1', user_id: '7', arrears: '0' } };
  const GOOD_PAYMENT = { id: 'pay_new', order_id: 'order_new', status: 'captured', amount: 125000 };

  test('it settles and records exactly what arrived', async () => {
    rzp.fetchOrder.mockResolvedValue(GOOD_ORDER);

    await PaymentService.settleFromWebhook(GOOD_PAYMENT);

    expect(settleWrites()).toHaveLength(1);
    expect(settleWrites()[0][0].data.amount_paid).toEqual({ increment: 1250 });
  });
});

describe('the normal overstay flow still works', () => {
  // ₹450 already collected, repriced to ₹1200 + ₹50, so ₹800 is outstanding.
  const PART_PAID = { ...REPRICED, amount_paid: 450 };
  const TOPUP_ORDER = { id: 'order_topup', amount: 80000, notes: { booking_id: '1', user_id: '7', arrears: '0' } };
  const TOPUP_PAYMENT = { id: 'pay_topup', order_id: 'order_topup', status: 'captured', amount: 80000 };

  beforeEach(() => {
    prisma.bookings.findUnique.mockResolvedValue(PART_PAID);
    rzp.fetchOrder.mockResolvedValue(TOPUP_ORDER);
  });

  test('the ₹800 difference is accepted', async () => {
    await PaymentService.settleFromWebhook(TOPUP_PAYMENT);
    expect(settleWrites()).toHaveLength(1);
  });

  test('it ADDS to what was collected instead of overwriting', async () => {
    await PaymentService.settleFromWebhook(TOPUP_PAYMENT);

    // ₹450 + ₹800 = ₹1250, the full price. Assigning would have been right
    // here too, which is exactly why the bug hid for so long.
    expect(settleWrites()[0][0].data.amount_paid).toEqual({ increment: 800 });
  });

  test('a top-up short of the difference is refused', async () => {
    // ₹500 against ₹800 outstanding.
    rzp.fetchOrder.mockResolvedValue({ ...TOPUP_ORDER, amount: 50000 });

    await expect(PaymentService.settleFromWebhook({ ...TOPUP_PAYMENT, amount: 50000 }))
      .rejects.toThrow(/no longer covers the booking/i);
    expect(settleWrites()).toEqual([]);
  });
});

describe('what is recorded is what arrived', () => {
  test('an overpayment records the larger figure, not the booking price', async () => {
    // ₹1550 against a ₹1250 booking with no arrears on the order. The booking
    // price is ₹1250, but ₹1550 is what we are holding, and a refund can only
    // honestly return money we actually took. This is the case where passing
    // the real paid amount matters: assuming "it covered the balance" would
    // record ₹1250 and quietly lose ₹300.
    rzp.fetchOrder.mockResolvedValue({
      id: 'order_over', amount: 155000, notes: { booking_id: '1', user_id: '7', arrears: '0' },
    });

    await PaymentService.settleFromWebhook({ id: 'pay_over', order_id: 'order_over', status: 'captured', amount: 155000 });

    expect(settleWrites()[0][0].data.amount_paid).toEqual({ increment: 1550 });
  });

  test('the QR path records what arrived too', async () => {
    // Same overpayment, through the owner's QR. Each caller has to pass the
    // real figure; the shared default only assumes it covered the balance.
    await PaymentService.settleFromQrCredit(
      { id: 'pay_qr', status: 'captured', amount: 155000 },
      { notes: { booking_id: '1', arrears: '0' } }
    );

    expect(settleWrites()[0][0].data.amount_paid).toEqual({ increment: 1550 });
  });

  test('verify records what arrived too', async () => {
    rzp.fetchOrder.mockResolvedValue({
      id: 'order_over', amount: 155000, notes: { booking_id: '1', user_id: '7', arrears: '0' },
    });
    rzp.fetchPayment.mockResolvedValue({
      id: 'pay_over', order_id: 'order_over', status: 'captured', amount: 155000, amount_refunded: 0,
    });

    await PaymentService.verifyRazorpayPayment('order_over', 'pay_over', 'sig', 1, 7);

    expect(settleWrites()[0][0].data.amount_paid).toEqual({ increment: 1550 });
  });
});

describe('arrears are never counted as paid towards the booking', () => {
  test('only the booking share of the payment is added', async () => {
    // ₹1250 for the booking plus ₹300 of old dues = ₹1550 collected.
    prisma.bookings.findUnique.mockResolvedValue(REPRICED);
    rzp.fetchOrder.mockResolvedValue({
      id: 'order_ar', amount: 155000, notes: { booking_id: '1', user_id: '7', arrears: '300' },
    });

    await PaymentService.settleFromWebhook({ id: 'pay_ar', order_id: 'order_ar', status: 'captured', amount: 155000 });

    // ₹1550 arrived, ₹300 of it settled an older debt.
    expect(settleWrites()[0][0].data.amount_paid).toEqual({ increment: 1250 });
  });
});
