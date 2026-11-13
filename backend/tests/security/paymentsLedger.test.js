/**
 * The payments ledger — one row per captured payment.
 *
 * bookings.payment_id is a single column that an overstay top-up overwrites,
 * so the payment before it stops existing anywhere. That was untidy until
 * duplicate-payment refunds arrived: _refundDuplicatePayment compared an
 * incoming payment against bookings.payment_id alone, so a late webhook retry
 * of a legitimate earlier payment looked like a second payment on a booking
 * already paid, and was refunded. ₹450 prepaid, ₹800 topped up, and the ₹450
 * handed back the moment Razorpay redelivered its first webhook.
 *
 * The ledger answers "have we seen this payment?" with a lookup instead of a
 * comparison against the most recent one. These tests drive the real service
 * against a stateful stand-in for the table, so a sequence of payments behaves
 * the way it would against a database rather than as independent mocks.
 *
 *   npx jest tests/security/paymentsLedger.test.js
 */
jest.mock('../../src/config/prisma', () => ({
  bookings: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  users: { update: jest.fn(), findMany: jest.fn() },
  payments: { findUnique: jest.fn(), create: jest.fn(), count: jest.fn() },
  $transaction: jest.fn(),
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
const Notify = require('../../src/services/notificationService');
const PaymentService = require('../../src/services/paymentService');

let booking;
let ledger;

const resetDb = () => {
  booking = {
    id: 1, user_id: 7,
    total_price: 400, advance_fee: 50, amount_paid: 0,
    spotter_earning: 320,
    status: 'active', payment_status: 'pending', payment_id: null,
    users: { id: 7, balance: 0 },
    parking_spots: { spotter_id: 3, location_type: 'urban' },
  };
  ledger = [];
};

/** Mocks that behave like the tables they stand for. */
const wireDb = () => {
  prisma.bookings.findUnique.mockImplementation(async () => ({ ...booking }));
  prisma.bookings.findFirst.mockResolvedValue(null);
  prisma.bookings.update.mockResolvedValue({});
  prisma.users.findMany.mockResolvedValue([{ id: 99 }]);
  prisma.users.update.mockResolvedValue({});

  // The atomic claim: settles only a booking that is not already paid.
  prisma.bookings.updateMany.mockImplementation(async ({ data }) => {
    if (booking.payment_status === 'paid') return { count: 0 };
    booking.payment_id = data.payment_id;
    booking.payment_status = 'paid';
    booking.amount_paid = Number(booking.amount_paid) + Number(data.amount_paid?.increment ?? 0);
    return { count: 1 };
  });

  prisma.payments.findUnique.mockImplementation(async ({ where }) =>
    ledger.find((r) => r.razorpay_payment_id === where.razorpay_payment_id) || null);
  prisma.payments.count.mockImplementation(async ({ where }) =>
    ledger.filter((r) => Number(r.booking_id) === Number(where.booking_id)).length);
  prisma.payments.create.mockImplementation(async ({ data }) => {
    // razorpay_payment_id is UNIQUE in the database.
    if (ledger.some((r) => r.razorpay_payment_id === data.razorpay_payment_id)) {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    }
    ledger.push({ ...data });
    return data;
  });

  prisma.$transaction.mockImplementation(async (fn) => fn({
    bookings: { updateMany: prisma.bookings.updateMany, update: prisma.bookings.update },
    payments: prisma.payments,
    users: { update: prisma.users.update },
  }));
};

/** Settle a captured payment through the webhook, as Razorpay would. */
const settle = async (id, paise, arrears = 0) => {
  rzp.fetchOrder.mockResolvedValue({
    id: `order_${id}`, amount: paise,
    notes: { booking_id: '1', user_id: '7', arrears: String(arrears) },
  });
  rzp.fetchPayment.mockResolvedValue({ id, order_id: `order_${id}`, status: 'captured', amount: paise, amount_refunded: 0 });
  return PaymentService.settleFromWebhook({ id, order_id: `order_${id}`, status: 'captured', amount: paise });
};

/** The driver overstays: complete() reprices and reopens payment. */
const overstayTo = (price) => {
  booking.total_price = price;
  booking.status = 'completed';
  booking.payment_status = 'pending';
};

const refunds = () => rzp.refund.mock.calls.map(([id, amt]) => [id, amt]);

beforeEach(() => {
  jest.clearAllMocks();
  resetDb();
  wireDb();
  rzp.refund.mockResolvedValue('rfnd_1');
  Notify.sendPushNotification.mockResolvedValue();
  Notify.notifyBookingPaid.mockResolvedValue();
});

describe('a legitimate earlier payment is not refunded when its webhook retries', () => {
  // The reproduction: ₹450 prepayment, overstay, ₹800 top-up, then Razorpay
  // redelivers the FIRST payment's webhook.
  const sequence = async () => {
    await settle('pay_A', 45000);
    overstayTo(1200);
    await settle('pay_B', 80000);
    return settle('pay_A', 45000);
  };

  test('refunds nothing', async () => {
    const r = await sequence();

    expect(refunds()).toEqual([]);
    expect(r.duplicate.duplicate).toBe(false);
    expect(r.duplicate.retry).toBe(true);
  });

  test('both payments are in the ledger, even though payment_id holds only the last', async () => {
    await sequence();

    expect(ledger.map((p) => p.razorpay_payment_id)).toEqual(['pay_A', 'pay_B']);
    // The column that used to be the only record still holds the most recent.
    expect(booking.payment_id).toBe('pay_B');
  });

  test('the ledger and amount_paid agree after the overstay', async () => {
    await sequence();

    const collected = ledger.reduce((s, p) => s + Number(p.amount) - Number(p.arrears_cleared), 0);
    expect(collected).toBe(1250);
    expect(Number(booking.amount_paid)).toBe(1250);
  });
});

describe('a genuine duplicate is still refunded', () => {
  test('a payment never seen before, on a booking already paid, is refunded once', async () => {
    await settle('pay_A', 45000);
    // The owner's QR, raised before the driver paid in the app.
    const r = await settle('pay_QR', 45000);

    expect(refunds()).toEqual([['pay_QR', 450]]);
    expect(r.duplicate.refunded).toBe(true);
  });

  test('the original is never the one refunded', async () => {
    await settle('pay_A', 45000);
    await settle('pay_QR', 45000);

    expect(refunds().map(([id]) => id)).not.toContain('pay_A');
  });

  test('and it is not added to the ledger — it was never ours to keep', async () => {
    await settle('pay_A', 45000);
    await settle('pay_QR', 45000);

    expect(ledger.map((p) => p.razorpay_payment_id)).toEqual(['pay_A']);
  });
});

describe('a redelivered webhook writes one row, not two', () => {
  test('the same payment arriving twice leaves a single ledger row', async () => {
    await settle('pay_A', 45000);
    await settle('pay_A', 45000);

    expect(ledger).toHaveLength(1);
    expect(refunds()).toEqual([]);
  });

  test('and does not add to amount_paid a second time', async () => {
    await settle('pay_A', 45000);
    await settle('pay_A', 45000);

    expect(Number(booking.amount_paid)).toBe(450);
  });

  test('a stale retry that no longer covers the reopened balance is refused outright', async () => {
    // Repriced to ₹1250 with ₹450 collected, so ₹800 is outstanding and the
    // old ₹450 payment is short. The amount guard rejects it before the
    // ledger is ever consulted.
    await settle('pay_A', 45000);
    overstayTo(1200);

    await expect(settle('pay_A', 45000)).rejects.toThrow(/no longer covers the booking/i);

    expect(ledger).toHaveLength(1);
    expect(Number(booking.amount_paid)).toBe(450);
  });

  test('a retry that DOES still cover the balance is stopped by the ledger', async () => {
    // Repriced to ₹750 with ₹450 collected: ₹300 outstanding, so the old ₹450
    // payment clears the amount guard and reaches the claim. complete() has
    // reopened payment_status, so the claim would succeed on its own — the
    // ledger check inside the transaction is the only thing stopping the same
    // payment settling a second time.
    await settle('pay_A', 45000);
    overstayTo(700);

    await settle('pay_A', 45000);

    expect(ledger).toHaveLength(1);
    expect(Number(booking.amount_paid)).toBe(450);
    expect(booking.payment_status).toBe('pending'); // still owed the difference
    expect(refunds()).toEqual([]);
  });
});

describe('the claim and the ledger row move together', () => {
  test('both happen inside one transaction', async () => {
    await settle('pay_A', 45000);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(ledger).toHaveLength(1);
    expect(booking.payment_status).toBe('paid');
  });

  test('a booking is never settled without its payment row', async () => {
    // If the ledger write fails, the claim must not stand.
    prisma.payments.create.mockRejectedValueOnce(new Error('ledger write failed'));
    // A real transaction rolls the claim back; model that here.
    prisma.$transaction.mockImplementation(async (fn) => {
      const before = { ...booking };
      try {
        return await fn({
          bookings: { updateMany: prisma.bookings.updateMany, update: prisma.bookings.update },
          payments: prisma.payments,
          users: { update: prisma.users.update },
        });
      } catch (e) {
        booking = before; // rollback
        throw e;
      }
    });

    await expect(settle('pay_A', 45000)).rejects.toThrow(/ledger write failed/);

    expect(booking.payment_status).toBe('pending');
    expect(booking.payment_id).toBeNull();
    expect(ledger).toEqual([]);
  });
});

describe('what the ledger records', () => {
  test('the amount is what Razorpay captured, with the arrears share noted', async () => {
    // ₹450 for the booking plus ₹300 of old dues = ₹750 captured.
    booking.users.balance = -300;
    await settle('pay_A', 75000, 300);

    expect(ledger[0]).toEqual(expect.objectContaining({
      booking_id: 1,
      razorpay_payment_id: 'pay_A',
      amount: 750,
      arrears_cleared: 300,
      status: 'captured',
    }));
    // Only the booking's share counts as paid towards it.
    expect(Number(booking.amount_paid)).toBe(450);
  });
});

describe('payments that cannot be judged are refused, not refunded', () => {
  test('a payment recorded against ANOTHER booking is not refunded', async () => {
    await settle('pay_A', 45000);
    // Somebody else's payment, already recorded against booking 99.
    ledger.push({ booking_id: 99, razorpay_payment_id: 'pay_OTHER', amount: 500, arrears_cleared: 0 });

    const r = await settle('pay_OTHER', 50000);

    expect(refunds()).toEqual([]);
    expect(r.duplicate.mismatched).toBe(true);
    expect(Notify.sendPushNotification).toHaveBeenCalledWith(99, expect.objectContaining({
      title: 'Duplicate payment needs review',
    }));
  });

  test('a booking with no ledger at all is not judged a duplicate', async () => {
    // Settled before the ledger existed: paid, but no rows. "Never seen" here
    // means "we have no records", not "this is extra". Refunding would hand
    // back a legitimate retry. The backfill script fills these in.
    booking.payment_status = 'paid';
    booking.payment_id = 'pay_OLD';
    booking.amount_paid = 450;

    const r = await settle('pay_OLD_RETRY', 45000);

    expect(refunds()).toEqual([]);
    expect(r.duplicate.unknown).toBe(true);
    expect(Notify.sendPushNotification).toHaveBeenCalledWith(99, expect.objectContaining({
      title: 'Duplicate payment needs review',
    }));
  });
});
