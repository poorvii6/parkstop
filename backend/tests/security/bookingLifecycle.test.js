/**
 * Reproduction tests for booking-lifecycle defects.
 *
 * These are written to FAIL against the code as it stands, so that the fix is
 * demonstrably a fix rather than an assertion of one. Real controller/model
 * code runs; prisma and the payment collaborators are mocked.
 */
jest.mock('../../src/config/prisma', () => ({
  bookings: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
  parking_spots: { findUnique: jest.fn(), update: jest.fn() },
  users: { findUnique: jest.fn(), update: jest.fn() },
  $transaction: jest.fn(),
  $executeRaw: jest.fn(),
}));
jest.mock('../../src/models/ParkingSpot', () => ({ findById: jest.fn() }));
jest.mock('../../src/services/notificationService', () => ({
  notifyNewBooking: jest.fn(), notifyBookingConfirmed: jest.fn(),
  notifyFinderNearby: jest.fn(), sendPushNotification: jest.fn(),
}));
jest.mock('../../src/services/paymentService', () => ({
  chargeUserForBooking: jest.fn(), splitAndPayout: jest.fn(), processRefund: jest.fn(),
}));
jest.mock('../../src/services/payments/PayoutService', () => ({ processBookingPayout: jest.fn() }));
jest.mock('../../src/services/payments/BookingSettlementService', () => ({ settleCompletedBooking: jest.fn() }));
jest.mock('../../src/config/socket', () => ({ emitToUser: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const prisma = require('../../src/config/prisma');
const ParkingSpot = require('../../src/models/ParkingSpot');
const Booking = require('../../src/models/Booking');
const BookingController = require('../../src/controllers/bookingController');

const makeRes = () => ({
  statusCode: 200, body: null,
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
});

/**
 * Builds a fake transaction client that records every call, so a test can ask
 * "was the spot's slot count ever touched?" rather than guessing.
 */
const makeTx = () => {
  const calls = { bookings: [], users: [], parking_spots: [] };
  return {
    calls,
    client: {
      bookings: {
        findUnique: jest.fn(async () => ({ id: 1, total_price: 100, status: 'completed' })),
        update: jest.fn(async (a) => { calls.bookings.push(a); return { id: 1, total_price: 100, ...a.data }; }),
        updateMany: jest.fn(async (a) => { calls.bookings.push(a); return { count: 1 }; }),
      },
      users: { update: jest.fn(async (a) => { calls.users.push(a); return {}; }) },
      parking_spots: { update: jest.fn(async (a) => { calls.parking_spots.push(a); return {}; }) },
    },
  };
};

beforeEach(() => jest.clearAllMocks());

describe('slot accounting on the cash and arrears checkout paths', () => {
  test('cash checkout returns the slot to the spot', async () => {
    const tx = makeTx();
    prisma.$transaction.mockImplementation(async (fn) => fn(tx.client));
    Booking.findById = jest.fn().mockResolvedValue({
      id: 1, user_id: 5, spot_id: 9, status: 'active', total_price: 100, vehicle_type: 'car',
    });
    ParkingSpot.findById.mockResolvedValue({
      id: 9, spotter_id: 7, location_type: 'urban', available_slots: 0, total_slots: 4,
    });

    const req = { user: { id: 7, role: 'spotter' }, params: { id: '1' }, body: {} };
    await BookingController.checkoutCash(req, makeRes());

    // The car has left. If the spot's count is not restored here, that slot is
    // gone for good — nothing downstream ever reconciles it.
    expect(tx.calls.parking_spots.length).toBeGreaterThan(0);
    expect(tx.calls.parking_spots[0].data.available_slots).toEqual({ increment: 1 });
  });

  test('arrears checkout returns the slot to the spot', async () => {
    const tx = makeTx();
    prisma.$transaction.mockImplementation(async (fn) => fn(tx.client));
    Booking.findById = jest.fn().mockResolvedValue({
      id: 2, user_id: 5, spot_id: 9, status: 'active', total_price: 100, vehicle_type: 'bike',
    });
    ParkingSpot.findById.mockResolvedValue({
      id: 9, spotter_id: 7, location_type: 'urban', available_slots: 0, total_slots: 4,
    });

    const req = { user: { id: 7, role: 'spotter' }, params: { id: '2' }, body: {} };
    await BookingController.checkoutUnpaid(req, makeRes());

    expect(tx.calls.parking_spots.length).toBeGreaterThan(0);
    expect(tx.calls.parking_spots[0].data.available_slots).toEqual({ increment: 1 });
  });
});

describe('cash checkout is not repeatable', () => {
  test('a second call on an already-completed booking is rejected', async () => {
    const tx = makeTx();
    prisma.$transaction.mockImplementation(async (fn) => fn(tx.client));
    Booking.findById = jest.fn().mockResolvedValue({
      id: 3, user_id: 5, spot_id: 9, status: 'completed', payment_status: 'paid',
      total_price: 100, vehicle_type: 'car',
    });
    ParkingSpot.findById.mockResolvedValue({ id: 9, spotter_id: 7, location_type: 'urban' });

    const req = { user: { id: 7, role: 'spotter' }, params: { id: '3' }, body: {} };
    const res = makeRes();
    await BookingController.checkoutCash(req, res);

    // Otherwise a double-tap debits the platform fee from the spotter twice.
    expect(res.statusCode).toBe(400);
    expect(tx.calls.users.length).toBe(0);
  });
});

describe('checkout OTP cannot be attacked by an unrelated spotter', () => {
  test('a spotter who does not own the spot is refused before any attempt is burned', async () => {
    Booking.findById = jest.fn().mockResolvedValue({ id: 4, user_id: 5, spot_id: 9, status: 'active' });
    ParkingSpot.findById.mockResolvedValue({ id: 9, spotter_id: 999 }); // someone else's spot
    const spy = jest.spyOn(Booking, 'verifyCheckoutOTP').mockResolvedValue({});

    const req = { user: { id: 7, role: 'spotter' }, body: { bookingId: 4, otp: '111111' } };
    const res = makeRes();
    await BookingController.verifyCheckoutOTP(req, res);

    // Three wrong guesses lock the booking permanently, so an unrelated spotter
    // must never reach the verifier at all.
    expect(spy).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    spy.mockRestore();
  });
});

describe('the expiry sweep cannot kill a booking that just checked in', () => {
  test('a reservation that became active between the scan and the write is left alone', async () => {
    // The sweep reads a list, then writes one row at a time. In that gap the
    // rider can hand over their OTP and the booking becomes active.
    prisma.bookings.findMany.mockResolvedValue([]);
    prisma.bookings.updateMany.mockResolvedValue({ count: 0 }); // someone else moved it first
    prisma.parking_spots.update.mockResolvedValue({});

    const { expireReservation } = require('../../src/services/bookingExpiryService');
    const released = await expireReservation(
      { id: 1, spot_id: 9, vehicle_type: 'car' },
      new Date()
    );

    // No row matched 'reserved' any more, so the spot must NOT get a slot back —
    // the car is physically parked in it.
    expect(released).toBe(false);
    expect(prisma.parking_spots.update).not.toHaveBeenCalled();
  });
});

describe('the reservation hold is anchored to arrival, not to tapping Book', () => {
  const spotRow = {
    id: 9, is_active: true, price_per_hour: 50, location_type: 'urban',
    car_slots: 2, bike_slots: 2, available_slots: 3, total_slots: 4,
  };
  const runCreate = (start, end, payment_mode = 'online') => {
    let captured = null;
    prisma.$transaction.mockImplementation(async (fn) => fn({
      $executeRaw: jest.fn(),
      parking_spots: { findUnique: jest.fn().mockResolvedValue(spotRow), update: jest.fn() },
      bookings: { create: jest.fn(async (a) => { captured = a.data; return { id: 10, ...a.data }; }) },
    }));
    return Booking.create({
      user_id: 5, spot_id: 9, vehicle_type: 'car', payment_mode,
      start_time: start.toISOString(), end_time: end.toISOString(),
    }).then(() => captured);
  };

  test('a book-now reservation still gets its 30 minutes', async () => {
    const now = Date.now();
    const data = await runCreate(new Date(now), new Date(now + 3600000));
    const holdMinutes = (new Date(data.otp_expires_at).getTime() - now) / 60000;
    expect(holdMinutes).toBeGreaterThan(29);
    expect(holdMinutes).toBeLessThan(31);
  });

  test('a modest clock skew is tolerated, not treated as scheduling', async () => {
    // A device running ten minutes fast must still be able to book.
    const skewed = new Date(Date.now() + 10 * 60000);
    const data = await runCreate(skewed, new Date(skewed.getTime() + 3600000));
    expect(data).not.toBeNull();
  });

  test('an online booking hours ahead is allowed and carries the advance fee', async () => {
    const later = new Date(Date.now() + 4 * 3600000);
    const data = await runCreate(later, new Date(later.getTime() + 3600000), 'online');
    expect(data.advance_fee).toBe(50);
    // The hold starts when they are due, not when they booked — otherwise a
    // booking made four hours ahead would expire three and a half hours before
    // its own start time.
    expect(new Date(data.otp_expires_at).getTime())
      .toBe(later.getTime() + 30 * 60000);
  });

  test('the same booking in cash is refused, and says why', async () => {
    const later = new Date(Date.now() + 4 * 3600000);
    await expect(
      runCreate(later, new Date(later.getTime() + 3600000), 'cash')
    ).rejects.toThrow(/online/i);
  });

  test('a book-now booking carries no advance fee', async () => {
    const now = new Date();
    const data = await runCreate(now, new Date(now.getTime() + 3600000), 'online');
    expect(data.advance_fee).toBe(0);
  });
});
