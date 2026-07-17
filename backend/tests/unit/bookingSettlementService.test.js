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
 * The behavior under test is the "safest" unified policy:
 *   - cash            -> mark paid, deduct platform fee from spotter wallet.
 *   - online + paid   -> queue a payout.
 *   - online + unpaid -> do nothing (never pay before collection).
 *   - on failure      -> record failed payout, credit wallet, notify spotter.
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

describe('cash payment', () => {
  test('marks paid and deducts the platform fee from the spotter wallet', async () => {
    const booking = { id: 3, total_price: 1000, payment_mode: 'cash', payment_status: 'pending_cash' };

    const result = await BookingSettlementService.settleCompletedBooking(booking, spot);

    expect(result).toEqual({ spotterEarning: 800, platformFee: 200, settled: true });
    expect(prisma.bookings.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ payment_status: 'paid' }) })
    );
    expect(prisma.users.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { balance: { decrement: 200 } } })
    );
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

describe('failure fallback', () => {
  test('records a failed payout, credits the wallet, and notifies the spotter', async () => {
    prisma.bookings.update.mockRejectedValueOnce(new Error('db exploded'));
    const booking = { id: 6, total_price: 1000, payment_mode: 'online', payment_status: 'paid' };

    const result = await BookingSettlementService.settleCompletedBooking(booking, spot);

    expect(result.settled).toBe(false);
    expect(prisma.payouts.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed_needs_retry', amount: 800 }),
      })
    );
    // Earnings are never lost: wallet credited as fallback.
    expect(prisma.users.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { balance: { increment: 800 } } })
    );
    expect(emitToUser).toHaveBeenCalledWith(7, 'payout:pending', expect.any(Object));
  });
});
