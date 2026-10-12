/**
 * The background sweep closes sessions through the normal checkout path and
 * recovers owner credits that never happened, without ever doubling them.
 *
 *   npx jest tests/security/sessionSweep.test.js
 */
jest.mock('../../src/config/prisma', () => ({ $queryRaw: jest.fn() }));
jest.mock('../../src/models/Booking', () => ({ complete: jest.fn() }));
jest.mock('../../src/services/payments/PayoutService', () => ({ processBookingPayout: jest.fn() }));
jest.mock('../../src/services/notificationService', () => ({}));
jest.mock('../../src/services/BookingRefundService', () => ({}));
jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const prisma = require('../../src/config/prisma');
const Booking = require('../../src/models/Booking');
const PayoutService = require('../../src/services/payments/PayoutService');
const { closeSession, recoverUnsettledPayouts } = require('../../src/services/bookingExpiryService');

beforeEach(() => jest.clearAllMocks());

test('closing a session uses Booking.complete (same bill, slot and commission as the owner path)', async () => {
  Booking.complete.mockResolvedValue({ id: 4, user_id: 2, status: 'completed' });
  const done = await closeSession(4);
  expect(Booking.complete).toHaveBeenCalledWith(4);
  expect(done.status).toBe('completed');
});

test('a session the owner already closed is left alone', async () => {
  Booking.complete.mockRejectedValue(new Error('Booking not active'));
  expect(await closeSession(4)).toBeNull();
});

test('other errors are not swallowed', async () => {
  Booking.complete.mockRejectedValue(new Error('db down'));
  await expect(closeSession(4)).rejects.toThrow('db down');
});

test('recovery credits each paid booking that has no payout, through the idempotent path', async () => {
  prisma.$queryRaw.mockResolvedValue([
    { id: 10, spotter_earning: '80.00', spotter_id: 7 },
    { id: 11, spotter_earning: '40.00', spotter_id: 8 },
  ]);
  PayoutService.processBookingPayout.mockResolvedValue({});
  await recoverUnsettledPayouts(new Date());
  expect(PayoutService.processBookingPayout).toHaveBeenCalledWith(10, 80, 7);
  expect(PayoutService.processBookingPayout).toHaveBeenCalledWith(11, 40, 8);
});

test('one failing booking does not stop the rest', async () => {
  prisma.$queryRaw.mockResolvedValue([
    { id: 10, spotter_earning: 80, spotter_id: 7 },
    { id: 11, spotter_earning: 40, spotter_id: 8 },
  ]);
  PayoutService.processBookingPayout.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({});
  await recoverUnsettledPayouts(new Date());
  expect(PayoutService.processBookingPayout).toHaveBeenCalledTimes(2);
});
