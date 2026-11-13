/**
 * The refund path, with prisma and the gateway mocked.
 *
 * The policy arithmetic is covered separately in tests/unit — what is checked
 * here is the ordering and the safety around it: that a retry cannot pay twice,
 * that a gateway failure leaves the booking recoverable rather than stuck, and
 * that a no-show is not refunded until it is claimed.
 */
jest.mock('../../src/config/prisma', () => ({
  bookings: { update: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
  parking_spots: { findUnique: jest.fn() },
  users: { update: jest.fn(), findMany: jest.fn() },
  payouts: { findFirst: jest.fn(), create: jest.fn() },
  $transaction: jest.fn(),
  $queryRaw: jest.fn(),
}));
jest.mock('../../src/services/paymentService', () => ({
  processRefund: jest.fn(),
  fetchRefundState: jest.fn(),
  markPaymentRefunded: jest.fn(),
}));
jest.mock('../../src/services/notificationService', () => ({ sendPushNotification: jest.fn(), notifyNoShowCredit: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// For the sweep and controller tests further down.
jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../../src/models/Booking', () => ({ findById: jest.fn(), cancel: jest.fn() }));
jest.mock('../../src/models/ParkingSpot', () => ({ findById: jest.fn() }));
jest.mock('../../src/config/socket', () => ({ emitToUser: jest.fn() }));
jest.mock('../../src/services/payments/PayoutService', () => ({}));
jest.mock('../../src/services/payments/BookingSettlementService', () => ({}));

const prisma = require('../../src/config/prisma');
const PaymentService = require('../../src/services/paymentService');
const NotificationService = require('../../src/services/notificationService');
const RefundService = require('../../src/services/BookingRefundService');
const { retryFailedRefunds, settleClaimableNoShows, remindUnclaimedRefunds } = require('../../src/services/bookingExpiryService');
const Booking = require('../../src/models/Booking');
const ParkingSpot = require('../../src/models/ParkingSpot');
const BookingController = require('../../src/controllers/bookingController');

const HOUR = 3600000;

// A ₹400 booking made 3 hours ahead: ₹450 collected, ₹50 of it the advance fee.
const makeBooking = (over = {}) => ({
  id: 100,
  user_id: 5,
  spot_id: 9,
  amount_paid: 450,
  advance_fee: 50,
  // Written in the same update as amount_paid, so a booking with money on it
  // always carries this. Owner settlement is gated on it.
  payment_status: 'paid',
  start_time: new Date(Date.now() + 4 * HOUR),
  payment_id: 'pay_abc123',
  ...over,
});

const spot = { id: 9, spotter_id: 7, location_type: 'urban' };

beforeEach(() => {
  jest.clearAllMocks();
  prisma.bookings.updateMany.mockResolvedValue({ count: 1 });
  prisma.bookings.update.mockResolvedValue({});
  prisma.users.update.mockResolvedValue({});
  // The owner's share of a cancellation is now recorded as a payouts row
  // before the wallet is credited, inside the same transaction.
  prisma.payouts.findFirst.mockResolvedValue(null);
  prisma.payouts.create.mockResolvedValue({});
  prisma.$transaction.mockImplementation(async (fn) =>
    fn({
      users: { update: prisma.users.update },
      bookings: { update: prisma.bookings.update },
      payouts: { findFirst: prisma.payouts.findFirst, create: prisma.payouts.create },
    })
  );
  PaymentService.processRefund.mockResolvedValue('rfnd_xyz');
  PaymentService.fetchRefundState.mockResolvedValue({ refundedPaise: 0, refundId: null });
  PaymentService.markPaymentRefunded.mockResolvedValue();
  prisma.users.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]); // two admins
  NotificationService.sendPushNotification.mockResolvedValue();
});

describe('cancelling well ahead', () => {
  test('refunds 70% of the spot fee and credits the owner the rest', async () => {
    const r = await RefundService.refundBooking(makeBooking(), spot);

    expect(r.tier).toBe('early_cancel');
    expect(r.refundAmount).toBe(280);
    expect(PaymentService.processRefund).toHaveBeenCalledWith(100, 280);

    // Owner: 80% of the ₹120 withheld, plus half the ₹50 fee.
    expect(prisma.users.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7 }, data: { balance: { increment: 121 } } })
    );
    expect(r.status).toBe('processed');
  });

  test('the advance fee is not part of what comes back', async () => {
    const r = await RefundService.refundBooking(makeBooking(), spot);
    // 70% of the ₹400 spot fee, NOT of the ₹450 collected.
    expect(r.refundAmount).toBe(280);
  });
});

describe('a refund cannot be paid twice', () => {
  test('a second caller that loses the claim does not touch the gateway', async () => {
    prisma.bookings.updateMany.mockResolvedValue({ count: 0 }); // someone got there first

    const r = await RefundService.refundBooking(makeBooking(), spot);

    expect(PaymentService.processRefund).not.toHaveBeenCalled();
    expect(prisma.users.update).not.toHaveBeenCalled();
    expect(r.status).toBe('already_handled');
  });

  test('the claim is guarded on refund status, not just booking id', async () => {
    await RefundService.refundBooking(makeBooking(), spot);

    const where = prisma.bookings.updateMany.mock.calls[0][0].where;
    expect(where.id).toBe(100);
    // Without this, a retry after a completed refund would sail through.
    expect(JSON.stringify(where)).toMatch(/processed/);
  });
});

describe('when the gateway fails', () => {
  test('the booking is left recoverable, not stuck mid-flight', async () => {
    PaymentService.processRefund.mockRejectedValue(new Error('gateway down'));

    const r = await RefundService.refundBooking(makeBooking(), spot);

    expect(r.status).toBe('failed');
    // 'processing' would sit behind the idempotency guard forever; 'failed' can
    // be retried by a human or a job.
    const wrote = prisma.bookings.update.mock.calls.some(
      (c) => c[0]?.data?.refund_status === 'failed'
    );
    expect(wrote).toBe(true);
    // And nobody is credited for a refund that did not happen.
    expect(prisma.users.update).not.toHaveBeenCalled();
  });
});

describe('no-shows: the driver claims, the owner is paid anyway', () => {
  const noShow = (over = {}) => makeBooking({ start_time: new Date(Date.now() - 2 * HOUR), ...over });

  test('the driver is not refunded until they ask', async () => {
    const r = await RefundService.refundBooking(noShow(), spot, { reason: 'no_show' });

    expect(r.status).toBe('claimable');
    expect(r.refundAmount).toBe(200); // 50% of the ₹400 spot fee
    expect(PaymentService.processRefund).not.toHaveBeenCalled();
  });

  test('the owner IS credited at expiry, without waiting for a claim', async () => {
    // The whole point. A driver who vanishes never claims, and the owner held
    // the bay empty regardless, so their share of the withheld money is theirs
    // now. Owner: 80% of the ₹200 withheld, plus half the ₹50 advance fee.
    const r = await RefundService.refundBooking(noShow(), spot, { reason: 'no_show' });

    expect(prisma.payouts.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          user_id: 7,
          booking_id: 100,
          amount: 185,
          purpose: 'no_show_settlement',
          mode: 'balance',
        }),
      })
    );
    expect(prisma.users.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7 }, data: { balance: { increment: 185 } } })
    );
    expect(prisma.users.update).toHaveBeenCalledTimes(1);
    expect(r.settlement.ownerAmount).toBe(185);
  });

  test('no gateway call is made to credit the owner', async () => {
    // Owner payouts are manual: this is a wallet credit, never a Razorpay call.
    await RefundService.refundBooking(noShow(), spot, { reason: 'no_show' });
    expect(PaymentService.processRefund).not.toHaveBeenCalled();
  });

  test('the payouts row, the credit and the booking update are ONE transaction', async () => {
    const order = [];
    prisma.$transaction.mockImplementation(async (fn) => fn({
      users: { update: () => { order.push('credit'); return Promise.resolve({}); } },
      bookings: { update: () => { order.push('booking'); return Promise.resolve({}); } },
      payouts: {
        findFirst: () => Promise.resolve(null),
        create: () => { order.push('payout_row'); return Promise.resolve({}); },
      },
    }));

    await RefundService.refundBooking(noShow(), spot, { reason: 'no_show' });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // Recorded before the balance moves, and the booking marked with them.
    expect(order).toEqual(['payout_row', 'credit', 'booking']);
    // Nothing was written outside the transaction.
    expect(prisma.bookings.update).not.toHaveBeenCalled();
    expect(prisma.users.update).not.toHaveBeenCalled();
  });

  test('an unpaid no-show is marked claimable but credits nobody', async () => {
    // An owner is never credited before the money is in.
    const r = await RefundService.refundBooking(
      noShow({ amount_paid: 0, advance_fee: 0, payment_status: 'pending' }), spot, { reason: 'no_show' }
    );

    expect(r.status).toBe('claimable');
    expect(prisma.payouts.create).not.toHaveBeenCalled();
    expect(prisma.users.update).not.toHaveBeenCalled();
    // Still claimable, so the driver keeps whatever right they had.
    expect(prisma.bookings.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ refund_status: 'claimable' }) })
    );
  });

  test('money recorded but not yet confirmed paid credits nobody', async () => {
    // The gate is the ONLY thing stopping this one: amount_paid is set, so the
    // withheld figure is non-zero and the settlement would otherwise pay out.
    // An owner is never credited before the money is in.
    const r = await RefundService.refundBooking(
      noShow({ payment_status: 'pending' }), spot, { reason: 'no_show' }
    );

    expect(r.status).toBe('claimable');
    expect(prisma.payouts.create).not.toHaveBeenCalled();
    expect(prisma.users.update).not.toHaveBeenCalled();
  });

  test('a later claim refunds the DRIVER and does not credit the owner twice', async () => {
    // Expiry already settled the owner, so the payouts row is there.
    prisma.payouts.findFirst.mockResolvedValue({ id: 55, booking_id: 100, amount: 185 });

    const r = await RefundService.refundBooking(
      noShow({ refund_status: 'claimable', refund_amount: 200 }),
      spot,
      { reason: 'no_show', force: true }
    );

    expect(r.status).toBe('processed');
    expect(PaymentService.processRefund).toHaveBeenCalledWith(100, 200); // driver paid
    expect(prisma.payouts.create).not.toHaveBeenCalled();               // no second row
    expect(prisma.users.update).not.toHaveBeenCalled();                 // no second credit
  });
});

describe('backfilling no-shows left claimable before expiry paid owners', () => {
  const claimableRow = (over = {}) => ({
    id: 100,
    user_id: 5,
    spot_id: 9,
    amount_paid: 450,
    advance_fee: 50,
    refund_amount: 200,
    refund_status: 'claimable',
    payment_status: 'paid',
    cancellation_reason: 'no_show',
    ...over,
  });

  beforeEach(() => {
    prisma.$queryRaw.mockResolvedValue([{ id: 100 }]);
    prisma.bookings.findUnique.mockResolvedValue(claimableRow());
    prisma.parking_spots.findUnique.mockResolvedValue(spot);
  });

  test('credits the owner their share, once', async () => {
    const n = await settleClaimableNoShows();

    expect(n).toBe(1);
    expect(prisma.payouts.create).toHaveBeenCalledTimes(1);
    expect(prisma.users.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7 }, data: { balance: { increment: 185 } } })
    );
    // A backfill must not move the driver's money.
    expect(PaymentService.processRefund).not.toHaveBeenCalled();
  });

  test('it pays the stored refund_amount, not a fresh quote', async () => {
    // A re-quote on a long-expired booking would produce a different withheld
    // figure, and the driver was already told the stored one.
    prisma.bookings.findUnique.mockResolvedValue(claimableRow({ refund_amount: 100 }));

    await settleClaimableNoShows();

    // Withheld is now ₹300: 80% of it is ₹240, plus ₹25 of the fee.
    expect(prisma.users.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { balance: { increment: 265 } } })
    );
  });

  test('a second sweep over the same booking credits nothing', async () => {
    // Guard 2: the row written by the first sweep is found inside the
    // transaction, even if the query still hands the booking over.
    prisma.payouts.findFirst.mockResolvedValue({ id: 55, booking_id: 100 });

    await settleClaimableNoShows();

    expect(prisma.payouts.create).not.toHaveBeenCalled();
    expect(prisma.users.update).not.toHaveBeenCalled();
  });

  test('the query itself excludes bookings that already have a payout', async () => {
    // Guard 1. Asserted on the SQL because it is the guard that keeps the
    // batch moving forward instead of re-reading settled rows every minute.
    await settleClaimableNoShows();

    const sql = prisma.$queryRaw.mock.calls[0][0].join('?');
    expect(sql).toMatch(/LEFT JOIN payouts/i);
    expect(sql).toMatch(/p\.id IS NULL/i);
    expect(sql).toMatch(/refund_status = 'claimable'/i);
    // An owner is never credited before the money is in.
    expect(sql).toMatch(/payment_status = 'paid'/i);
    // Skips bookings that withhold nothing, which would never write a row and
    // so would be re-selected forever.
    expect(sql).toMatch(/refund_amount < b\.amount_paid/i);
  });

  test('an unpaid booking handed over anyway is still not credited', async () => {
    prisma.bookings.findUnique.mockResolvedValue(claimableRow({ payment_status: 'pending' }));

    await settleClaimableNoShows();

    expect(prisma.payouts.create).not.toHaveBeenCalled();
    expect(prisma.users.update).not.toHaveBeenCalled();
  });

  test('one bad row does not stop the rest of the batch', async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: 100 }, { id: 101 }]);
    prisma.bookings.findUnique
      .mockRejectedValueOnce(new Error('spot deleted'))
      .mockResolvedValueOnce(claimableRow({ id: 101 }));

    const n = await settleClaimableNoShows();

    expect(n).toBe(2);
    expect(prisma.payouts.create).toHaveBeenCalledTimes(1);
  });
});

describe('cash bookings', () => {
  test('nothing was collected, so nothing is refunded', async () => {
    const cash = makeBooking({ amount_paid: 0, advance_fee: 0, payment_id: null });

    const r = await RefundService.refundBooking(cash, spot);

    expect(r.refundAmount).toBe(0);
    expect(PaymentService.processRefund).not.toHaveBeenCalled();
  });
});

describe('quote', () => {
  test('previews the same number the refund will actually pay', async () => {
    const booking = makeBooking();
    const preview = RefundService.quote(booking);
    const actual = await RefundService.refundBooking(booking, spot);

    // The app shows the preview on the confirm dialog; if these ever diverge,
    // the finder is told one figure and paid another.
    expect(preview.refundAmount).toBe(actual.refundAmount);
  });
});

// ---------------------------------------------------------------------------
// Failed refunds: classification, reconciliation and retry
// ---------------------------------------------------------------------------

// What Razorpay's SDK rejects with when it refuses a request.
const razorpayError = (statusCode, description = 'Bad request') =>
  Object.assign(new Error(description), { statusCode, error: { code: 'BAD_REQUEST_ERROR', description } });

const wroteStatus = (status) =>
  prisma.bookings.update.mock.calls.some((c) => c[0]?.data?.refund_status === status);

// An early cancellation (₹280, 70%) whose first gateway call failed. It is now
// inside the last half hour, so a fresh quote would only give ₹200 (50%).
const failedBooking = (over = {}) => makeBooking({
  refund_status: 'failed',
  refund_amount: 280,
  cancellation_reason: 'finder_cancelled',
  start_time: new Date(Date.now() + 10 * 60 * 1000),
  ...over,
});

describe('a gateway error is sorted into retryable or not', () => {
  test('a Razorpay 4xx is permanent: needs_review, admins told, never "failed"', async () => {
    PaymentService.processRefund.mockRejectedValue(razorpayError(400, 'Refund amount exceeds captured'));

    const r = await RefundService.refundBooking(makeBooking(), spot);

    expect(r.status).toBe('needs_review');
    expect(wroteStatus('needs_review')).toBe(true);
    expect(wroteStatus('failed')).toBe(false);
    // Both admins pushed.
    const adminPushes = NotificationService.sendPushNotification.mock.calls
      .filter((c) => c[1]?.data?.type === 'refund_needs_review');
    expect(adminPushes.map((c) => c[0]).sort()).toEqual([1, 2]);
    expect(prisma.users.update).not.toHaveBeenCalled();
  });

  test.each([
    ['a 5xx', razorpayError(502, 'Bad gateway')],
    ['a network error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
    ['a 429 rate limit', razorpayError(429, 'Too many requests')],
  ])('%s is temporary: failed, so it gets retried, and no admin is paged', async (_, err) => {
    PaymentService.processRefund.mockRejectedValue(err);

    const r = await RefundService.refundBooking(makeBooking(), spot);

    expect(r.status).toBe('failed');
    expect(wroteStatus('failed')).toBe(true);
    expect(wroteStatus('needs_review')).toBe(false);
    expect(NotificationService.sendPushNotification).not.toHaveBeenCalled();
  });

  test('needs_review is terminal: the claim guard will not start a refund from it', async () => {
    expect(RefundService.TERMINAL_REFUND_STATUSES).toContain('needs_review');
    await RefundService.refundBooking(makeBooking(), spot);
    const where = JSON.stringify(prisma.bookings.updateMany.mock.calls[0][0].where);
    expect(where).toMatch(/needs_review/);
  });
});

describe('retrying a failed refund', () => {
  test('if the earlier refund actually went through, it is recorded and refund is NOT called again', async () => {
    // Timed out on our side, accepted on Razorpay's: ₹280 is already refunded.
    PaymentService.fetchRefundState.mockResolvedValue({ refundedPaise: 28000, refundId: 'rfnd_late' });

    const r = await RefundService.retryRefund(failedBooking(), spot);

    expect(PaymentService.processRefund).not.toHaveBeenCalled();
    expect(r.status).toBe('processed');
    expect(r.reconciled).toBe(true);
    const done = prisma.bookings.update.mock.calls.find((c) => c[0].data.refund_status === 'processed');
    expect(done[0].data).toMatchObject({ refund_amount: 280, refund_id: 'rfnd_late' });
    expect(PaymentService.markPaymentRefunded).toHaveBeenCalledWith(expect.objectContaining({ id: 100 }), 280);
    // The owner is still credited their share, once.
    expect(prisma.users.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { balance: { increment: 121 } } })
    );
  });

  test('Razorpay is asked before refund is called, never after', async () => {
    await RefundService.retryRefund(failedBooking(), spot);

    const asked = PaymentService.fetchRefundState.mock.invocationCallOrder[0];
    const paid = PaymentService.processRefund.mock.invocationCallOrder[0];
    expect(asked).toBeLessThan(paid);
    expect(PaymentService.fetchRefundState).toHaveBeenCalledWith('pay_abc123');
  });

  test('it pays the stored refund_amount, not a fresh (lower) quote', async () => {
    const booking = failedBooking();
    // Sanity: re-quoting now would give the late-cancel figure.
    expect(RefundService.quote(booking).refundAmount).toBe(200);

    const r = await RefundService.retryRefund(booking, spot);

    expect(PaymentService.processRefund).toHaveBeenCalledWith(100, 280);
    expect(r.refundAmount).toBe(280);
    expect(r.status).toBe('processed');
    // And the owner is settled on that same figure: ₹120 withheld → ₹121.
    expect(prisma.users.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { balance: { increment: 121 } } })
    );
  });

  test('refundBooking on a booking that already failed goes down the retry path', async () => {
    const r = await RefundService.refundBooking(failedBooking(), spot);

    expect(PaymentService.fetchRefundState).toHaveBeenCalled();
    expect(PaymentService.processRefund).toHaveBeenCalledWith(100, 280);
    expect(r.refundAmount).toBe(280);
  });

  test('a partial refund on record is not topped up blindly; a human looks', async () => {
    PaymentService.fetchRefundState.mockResolvedValue({ refundedPaise: 10000, refundId: 'rfnd_x' });

    const r = await RefundService.retryRefund(failedBooking(), spot);

    expect(r.status).toBe('needs_review');
    expect(PaymentService.processRefund).not.toHaveBeenCalled();
    expect(prisma.users.update).not.toHaveBeenCalled();
  });

  test('more refunded than owed: no more money out, and a human looks', async () => {
    // e.g. the 50% claim was retried blindly and Razorpay returned 100%.
    PaymentService.fetchRefundState.mockResolvedValue({ refundedPaise: 40000, refundId: 'rfnd_x' });

    const r = await RefundService.retryRefund(failedBooking(), spot);

    expect(r.status).toBe('needs_review');
    expect(PaymentService.processRefund).not.toHaveBeenCalled();
  });

  test('if Razorpay cannot be read, nothing is refunded and it stays failed for later', async () => {
    PaymentService.fetchRefundState.mockRejectedValue(new Error('ETIMEDOUT'));

    const r = await RefundService.retryRefund(failedBooking(), spot);

    expect(r.status).toBe('failed');
    expect(PaymentService.processRefund).not.toHaveBeenCalled();
    const back = prisma.bookings.update.mock.calls.find((c) => c[0].data.refund_status === 'failed');
    // updated_at refreshed, so the sweep waits another 15 minutes.
    expect(back[0].data.updated_at).toBeInstanceOf(Date);
  });

  test('the retry claims the row with the same guard, and only from "failed"', async () => {
    await RefundService.retryRefund(failedBooking(), spot);

    const where = prisma.bookings.updateMany.mock.calls[0][0].where;
    const json = JSON.stringify(where);
    expect(json).toMatch(/processed/);
    expect(json).toMatch(/"refund_status":"failed"/);
  });

  test('a retry that loses the claim touches neither Razorpay call', async () => {
    prisma.bookings.updateMany.mockResolvedValue({ count: 0 });

    const r = await RefundService.retryRefund(failedBooking(), spot);

    expect(r.status).toBe('already_handled');
    expect(PaymentService.fetchRefundState).not.toHaveBeenCalled();
    expect(PaymentService.processRefund).not.toHaveBeenCalled();
  });

  test('the driver is pushed when a retried refund finally succeeds', async () => {
    await RefundService.retryRefund(failedBooking(), spot);

    expect(NotificationService.sendPushNotification).toHaveBeenCalledWith(5, expect.objectContaining({
      data: expect.objectContaining({ type: 'refund_processed', bookingId: 100 }),
    }));
  });

  test('the driver is not pushed when the retry fails again', async () => {
    PaymentService.processRefund.mockRejectedValue(razorpayError(503, 'Service unavailable'));

    const r = await RefundService.retryRefund(failedBooking(), spot);

    expect(r.status).toBe('failed');
    const driverPush = NotificationService.sendPushNotification.mock.calls.some((c) => c[0] === 5);
    expect(driverPush).toBe(false);
  });
});

describe('the retry sweep', () => {
  test('picks a few failed refunds that have waited 15 minutes, and retries each', async () => {
    const now = new Date('2026-11-13T10:00:00Z');
    prisma.bookings.findMany.mockResolvedValue([failedBooking({ id: 100 }), failedBooking({ id: 101 })]);
    prisma.parking_spots.findUnique.mockResolvedValue(spot);

    const n = await retryFailedRefunds(now);

    expect(n).toBe(2);
    const q = prisma.bookings.findMany.mock.calls[0][0];
    expect(q.where.refund_status).toBe('failed');
    expect(q.where.updated_at.lt).toEqual(new Date(now.getTime() - 15 * 60 * 1000));
    expect(q.take).toBeGreaterThan(0);
    expect(q.take).toBeLessThanOrEqual(10);
    expect(PaymentService.processRefund).toHaveBeenCalledWith(100, 280);
    expect(PaymentService.processRefund).toHaveBeenCalledWith(101, 280);
  });

  test('one bad row does not stop the rest', async () => {
    prisma.bookings.findMany.mockResolvedValue([failedBooking({ id: 100 }), failedBooking({ id: 101 })]);
    prisma.parking_spots.findUnique
      .mockRejectedValueOnce(new Error('db hiccup'))
      .mockResolvedValue(spot);

    await retryFailedRefunds(new Date());

    expect(PaymentService.processRefund).toHaveBeenCalledTimes(1);
    expect(PaymentService.processRefund).toHaveBeenCalledWith(101, 280);
  });
});

describe('the endpoints', () => {
  const makeRes = () => ({
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  });
  const req = { user: { id: 5, role: 'FINDER' }, params: { id: '100' } };

  beforeEach(() => {
    ParkingSpot.findById.mockResolvedValue(spot);
    Booking.cancel.mockResolvedValue({});
  });

  test('claimRefund accepts a failed refund and tries again, at the stored amount', async () => {
    Booking.findById.mockResolvedValue(failedBooking());
    const res = makeRes();

    await BookingController.claimRefund(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({ refund_status: 'processed', refund_amount: 280 });
    expect(PaymentService.fetchRefundState).toHaveBeenCalled();
    expect(PaymentService.processRefund).toHaveBeenCalledWith(100, 280);
  });

  test('claimRefund on a needs_review refund pays nothing', async () => {
    Booking.findById.mockResolvedValue(failedBooking({ refund_status: 'needs_review' }));
    const res = makeRes();

    await BookingController.claimRefund(req, res);

    expect(res.body.data.refund_status).toBe('needs_review');
    expect(PaymentService.processRefund).not.toHaveBeenCalled();
  });

  test('cancelBooking tells the driver a failed refund is being retried', async () => {
    Booking.findById.mockResolvedValue(makeBooking());
    PaymentService.processRefund.mockRejectedValue(new Error('gateway down'));
    const res = makeRes();

    await BookingController.cancelBooking(req, res);

    expect(res.body.data.refund_status).toBe('failed');
    expect(res.body.message).toMatch(/retrying/i);
    expect(res.body.message).not.toBe('Booking cancelled successfully');
  });

  test('cancelBooking still says the money is coming when it went through', async () => {
    Booking.findById.mockResolvedValue(makeBooking());
    const res = makeRes();

    await BookingController.cancelBooking(req, res);

    expect(res.body.message).toMatch(/₹280 will be returned/);
  });
});

describe('policy helpers used by the retry', () => {
  const Policy = require('../../src/services/BookingRefundPolicy');

  test.each([
    [280, 0, 'none'],
    [280, 28000, 'full'],
    [280, 10000, 'partial'],
    [280, 40000, 'over'],
    [280.5, 28050, 'full'],
  ])('owed ₹%s, refunded %s paise → %s', (owed, refundedPaise, want) => {
    expect(Policy.refundCoverage({ owed, refundedPaise })).toBe(want);
  });

  test('withheldFor matches refundFor for the same refund', () => {
    const q = Policy.refundFor({ spotFee: 400, advanceFee: 50, startTime: Date.now() + 4 * HOUR, now: Date.now() });
    const w = Policy.withheldFor({ spotFee: 400, advanceFee: 50, refundAmount: q.refundAmount });
    expect(w.withheldAmount).toBe(q.withheldAmount);
    expect(w.withheldSpotFee).toBe(120);
  });
});

describe('the owner is told about a no-show credit', () => {
  // The money lands in their wallet with no booking to explain it, so the
  // only thing standing between that and "where did this come from" is this
  // notification.
  const claimableBooking = (over = {}) => ({
    id: 100, user_id: 5, spot_id: 9,
    amount_paid: 450, advance_fee: 50, payment_status: 'paid',
    start_time: new Date(Date.now() + 4 * 3600000),
    ...over,
  });

  test('a credit at expiry is announced to the owner, once, with the amount', async () => {
    prisma.payouts.findFirst.mockResolvedValue(null);
    await RefundService.settleNoShowWithheld(claimableBooking(), spot, {
      refundAmount: 200, markClaimable: true,
    });

    expect(NotificationService.notifyNoShowCredit).toHaveBeenCalledTimes(1);
    const [ownerId, , , amount] = NotificationService.notifyNoShowCredit.mock.calls[0];
    expect(ownerId).toBe(spot.spotter_id);
    expect(amount).toBe(185);   // 80% of the 200 withheld + half the 50 fee
  });

  test('a booking already settled says nothing: no second announcement', async () => {
    // The later claim runs the same settlement. Telling them again would read
    // as a second payment.
    prisma.payouts.findFirst.mockResolvedValue({ id: 1, booking_id: 100 });
    await RefundService.settleNoShowWithheld(claimableBooking(), spot, { refundAmount: 200 });

    expect(NotificationService.notifyNoShowCredit).not.toHaveBeenCalled();
  });

  test('nothing collected, nothing credited, nothing announced', async () => {
    prisma.payouts.findFirst.mockResolvedValue(null);
    await RefundService.settleNoShowWithheld(
      claimableBooking({ payment_status: 'pending' }), spot, { refundAmount: 200 },
    );

    expect(NotificationService.notifyNoShowCredit).not.toHaveBeenCalled();
  });

  test('a push that throws does not undo the credit', async () => {
    prisma.payouts.findFirst.mockResolvedValue(null);
    NotificationService.notifyNoShowCredit.mockRejectedValueOnce(new Error('device offline'));

    const r = await RefundService.settleNoShowWithheld(claimableBooking(), spot, { refundAmount: 200 });

    expect(r.credited).toBe(true);
    expect(prisma.users.update).toHaveBeenCalled();
  });
});

describe('reminding a driver about an unclaimed refund', () => {
  const now = new Date('2026-11-13T10:00:00Z');
  const DAY = 24 * 3600000;

  test('reminds at three days and again at seven, and the last one says so', async () => {
    prisma.bookings.findMany
      .mockResolvedValueOnce([{ id: 100, user_id: 5, refund_amount: 200 }])   // 3-day window
      .mockResolvedValueOnce([{ id: 101, user_id: 6, refund_amount: 150 }]);  // 7-day window

    const sent = await remindUnclaimedRefunds(now);

    expect(sent).toBe(2);
    const first = NotificationService.sendPushNotification.mock.calls[0][1];
    const last = NotificationService.sendPushNotification.mock.calls[1][1];
    expect(first.title).toContain('200');
    expect(first.title).not.toMatch(/last/i);
    expect(last.title).toMatch(/last reminder/i);
  });

  test('each milestone is a one-minute window, so nobody is pestered every minute', async () => {
    prisma.bookings.findMany.mockResolvedValue([]);
    await remindUnclaimedRefunds(now);

    const [three, seven] = prisma.bookings.findMany.mock.calls.map((c) => c[0].where);
    expect(three.refund_status).toBe('claimable');
    expect(three.updated_at.lte).toEqual(new Date(now.getTime() - 3 * DAY));
    expect(three.updated_at.gt).toEqual(new Date(now.getTime() - 3 * DAY - 60000));
    expect(seven.updated_at.lte).toEqual(new Date(now.getTime() - 7 * DAY));
  });

  test('only refunds with money on them are chased', async () => {
    prisma.bookings.findMany.mockResolvedValue([]);
    await remindUnclaimedRefunds(now);
    expect(prisma.bookings.findMany.mock.calls[0][0].where.refund_amount).toEqual({ gt: 0 });
  });

  test('one failed push does not stop the rest', async () => {
    prisma.bookings.findMany
      .mockResolvedValueOnce([
        { id: 100, user_id: 5, refund_amount: 200 },
        { id: 101, user_id: 6, refund_amount: 300 },
      ])
      .mockResolvedValueOnce([]);
    NotificationService.sendPushNotification.mockRejectedValueOnce(new Error('no token'));

    const sent = await remindUnclaimedRefunds(now);

    expect(sent).toBe(1);
    expect(NotificationService.sendPushNotification).toHaveBeenCalledTimes(2);
  });
});
