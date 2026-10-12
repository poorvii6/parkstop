/**
 * Unit tests for BookingSettlementService — the unified commission-split /
 * payout engine extracted from BookingController.
 *
 * Prisma, the payout queue, the socket layer, and the logger are mocked, so
 * these run with NO database or Redis. Run with:
 *   npx jest tests/unit/bookingSettlementService.test.js
 *
 * CommissionService is left real (pure, already tested) to verify the wiring.
 *
 * The policy under test:
 *   - paid            -> queue the owner credit (idempotent downstream).
 *   - not paid        -> do nothing (never pay before collection).
 *   - on failure      -> change nothing; the recovery sweep retries.
 */

jest.mock('../../src/config/prisma', () => ({
  bookings: { update: jest.fn() },
  users: { update: jest.fn() },
  payouts: { create: jest.fn() },
}));
jest.mock('../../src/jobs/queues', () => ({ payoutQueue: { add: jest.fn() } }));
jest.mock('../../src/config/socket', () => ({ emitToUser: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const prisma = require('../../src/config/prisma');
const { payoutQueue } = require('../../src/jobs/queues');
const { emitToUser } = require('../../src/config/socket');
const BookingSettlementService = require('../../src/services/payments/BookingSettlementService');

const spot = { spotter_id: 7, location_type: 'urban' };

beforeEach(() => {
  jest.clearAllMocks();
  prisma.bookings.update.mockResolvedValue({});
  prisma.users.update.mockResolvedValue({});
  prisma.payouts.create.mockResolvedValue({});
  payoutQueue.add.mockResolvedValue({});
});

describe('online payment', () => {
  test('paid booking queues a payout with the commission split', async () => {
    const booking = { id: 1, total_price: 1000, payment_mode: 'online', payment_status: 'paid' };

    const result = await BookingSettlementService.settleCompletedBooking(booking, spot);

    expect(result).toEqual({ spotterEarning: 800, platformFee: 200, settled: true });
    expect(payoutQueue.add).toHaveBeenCalledWith(
      'process-payout',
      { bookingId: 1, spotterEarning: 800, spotterId: 7 }
    );
    // Spotter wallet is NOT touched on the online happy path.
    expect(prisma.users.update).not.toHaveBeenCalled();
  });

  test('unpaid booking does NOT pay out (the finderCheckout gap, now closed)', async () => {
    const booking = { id: 2, total_price: 1000, payment_mode: 'online', payment_status: 'pending' };

    const result = await BookingSettlementService.settleCompletedBooking(booking, spot);

    expect(result.settled).toBe(false);
    expect(payoutQueue.add).not.toHaveBeenCalled();
    expect(prisma.bookings.update).not.toHaveBeenCalled();
  });
});

describe('legacy cash booking', () => {
  test('an unpaid cash booking is never settled (ParkStop is online-only)', async () => {
    const booking = { id: 3, total_price: 1000, payment_mode: 'cash', payment_status: 'pending_cash' };
    const result = await BookingSettlementService.settleCompletedBooking(booking, spot);
    expect(result.settled).toBe(false);
    expect(prisma.users.update).not.toHaveBeenCalled();
    expect(payoutQueue.add).not.toHaveBeenCalled();
  });
});

describe('guards', () => {
  test('does nothing when the spot has no spotter', async () => {
    const booking = { id: 4, total_price: 1000, payment_mode: 'online', payment_status: 'paid' };
    const result = await BookingSettlementService.settleCompletedBooking(booking, { spotter_id: null });
    expect(result.settled).toBe(false);
    expect(payoutQueue.add).not.toHaveBeenCalled();
  });

  test('does nothing when spot is missing entirely', async () => {
    const booking = { id: 5, total_price: 1000, payment_mode: 'online', payment_status: 'paid' };
    const result = await BookingSettlementService.settleCompletedBooking(booking, null);
    expect(result.settled).toBe(false);
  });
});

describe('failure', () => {
  test('nothing is credited by hand; the recovery sweep retries later', async () => {
    prisma.bookings.update.mockRejectedValueOnce(new Error('db exploded'));
    const booking = { id: 6, total_price: 1000, payment_mode: 'online', payment_status: 'paid' };

    const result = await BookingSettlementService.settleCompletedBooking(booking, spot);

    expect(result.settled).toBe(false);
    // A hand-made credit here used to be paid AGAIN on retry. Not any more.
    expect(prisma.users.update).not.toHaveBeenCalled();
    expect(prisma.payouts.create).not.toHaveBeenCalled();
  });
});
