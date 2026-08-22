/**
 * The owner-confirmation gate must not have a side door.
 *
 * PUT /bookings/:id/finder-checkout used to call Booking.complete() straight
 * from the finder's own request — no checkout OTP, and no spot owner asked
 * whether the car had actually left. Meanwhile the real flow makes the finder
 * request checkout and the owner confirm it. A rider who knew the old endpoint
 * existed could skip the person whose driveway they were sitting in.
 *
 * These tests pin the door shut: the endpoint answers and completes nothing.
 */
jest.mock('../../src/config/prisma', () => ({
  users: { findUnique: jest.fn() },
  bookings: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
}));
jest.mock('../../src/models/Booking', () => ({ findById: jest.fn(), complete: jest.fn() }));
jest.mock('../../src/models/ParkingSpot', () => ({ findById: jest.fn() }));
jest.mock('../../src/services/notificationService', () => ({}));
jest.mock('../../src/services/paymentService', () => ({}));
jest.mock('../../src/services/payments/PayoutService', () => ({}));
jest.mock('../../src/services/payments/BookingSettlementService', () => ({ settleCompletedBooking: jest.fn() }));
jest.mock('../../src/services/BookingRefundService', () => ({ refundBooking: jest.fn(), quote: jest.fn() }));
jest.mock('../../src/config/socket', () => ({ emitToUser: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const Booking = require('../../src/models/Booking');
const BookingSettlementService = require('../../src/services/payments/BookingSettlementService');
const BookingController = require('../../src/controllers/bookingController');

const makeRes = () => ({
  statusCode: 200, body: null,
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
});

const FINDER = 5;

beforeEach(() => {
  jest.clearAllMocks();
  // An active booking that genuinely belongs to this finder — so the refusal
  // cannot be mistaken for an ownership check doing the work.
  Booking.findById.mockResolvedValue({ id: 100, user_id: FINDER, spot_id: 9, status: 'active' });
});

const call = async () => {
  const res = makeRes();
  await BookingController.finderCheckout(
    { user: { id: FINDER, role: 'finder' }, params: { id: '100' } },
    res
  );
  return res;
};

describe('the retired finder-checkout side door', () => {
  test('the finder cannot complete their own booking without the owner', async () => {
    const res = await call();
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('CHECKOUT_REQUIRES_OWNER');
  });

  test('nothing is completed and no money moves', async () => {
    await call();
    expect(Booking.complete).not.toHaveBeenCalled();
    expect(BookingSettlementService.settleCompletedBooking).not.toHaveBeenCalled();
  });

  test('an old client gets a usable answer, not a 404', async () => {
    // The route stays mounted on purpose. A 404 reads as "server broken" and
    // sends the rider to support; 409 with a message tells them what to do.
    const res = await call();
    expect(res.statusCode).not.toBe(404);
    expect(typeof res.body.message).toBe('string');
    expect(res.body.message.length).toBeGreaterThan(0);
  });
});
