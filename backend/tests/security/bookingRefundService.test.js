/**
 * The refund path, with prisma and the gateway mocked.
 *
 * The policy arithmetic is covered separately in tests/unit — what is checked
 * here is the ordering and the safety around it: that a retry cannot pay twice,
 * that a gateway failure leaves the booking recoverable rather than stuck, and
 * that a no-show is not refunded until it is claimed.
 */
jest.mock('../../src/config/prisma', () => ({
  bookings: { update: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn() },
  parking_spots: { findUnique: jest.fn() },
  users: { update: jest.fn() },
  $transaction: jest.fn(),
}));
jest.mock('../../src/services/paymentService', () => ({ processRefund: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const prisma = require('../../src/config/prisma');
const PaymentService = require('../../src/services/paymentService');
const RefundService = require('../../src/services/BookingRefundService');

const HOUR = 3600000;

// A ₹400 booking made 3 hours ahead: ₹450 collected, ₹50 of it the advance fee.
const makeBooking = (over = {}) => ({
  id: 100,
  user_id: 5,
  spot_id: 9,
  amount_paid: 450,
  advance_fee: 50,
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
  prisma.$transaction.mockImplementation(async (fn) =>
    fn({ users: { update: prisma.users.update }, bookings: { update: prisma.bookings.update } })
  );
  PaymentService.processRefund.mockResolvedValue('rfnd_xyz');
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

describe('no-shows have to be claimed', () => {
  const noShow = () => makeBooking({ start_time: new Date(Date.now() - 2 * HOUR) });

  test('the sweep marks it claimable and pays nothing', async () => {
    const r = await RefundService.refundBooking(noShow(), spot, { reason: 'no_show' });

    expect(r.status).toBe('claimable');
    expect(r.refundAmount).toBe(200); // 50% of the ₹400 spot fee
    expect(PaymentService.processRefund).not.toHaveBeenCalled();
  });

  test('the claim endpoint forces it through', async () => {
    const r = await RefundService.refundBooking(noShow(), spot, { reason: 'no_show', force: true });

    expect(r.status).toBe('processed');
    expect(PaymentService.processRefund).toHaveBeenCalledWith(100, 200);
    // Owner: 80% of the ₹200 withheld, plus half the fee.
    expect(prisma.users.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { balance: { increment: 185 } } })
    );
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
