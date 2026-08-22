/**
 * GET /bookings/:id/checkout-amount used to have no authorization whatsoever.
 *
 * Any authenticated user could walk booking ids and read each one's price —
 * and with it the rider's arrears, which is their negative wallet balance
 * across the whole platform. These tests pin the two people entitled to it and
 * the fact that the owner is told the total without the breakdown.
 */
jest.mock('../../src/config/prisma', () => ({
  users: { findUnique: jest.fn() },
  bookings: { findUnique: jest.fn() },
}));
jest.mock('../../src/models/Booking', () => ({ findById: jest.fn() }));
jest.mock('../../src/models/ParkingSpot', () => ({ findById: jest.fn() }));
jest.mock('../../src/services/notificationService', () => ({}));
jest.mock('../../src/services/paymentService', () => ({}));
jest.mock('../../src/services/payments/PayoutService', () => ({}));
jest.mock('../../src/services/payments/BookingSettlementService', () => ({ settleCompletedBooking: jest.fn() }));
jest.mock('../../src/services/BookingRefundService', () => ({ refundBooking: jest.fn(), quote: jest.fn() }));
jest.mock('../../src/config/socket', () => ({ emitToUser: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const prisma = require('../../src/config/prisma');
const Booking = require('../../src/models/Booking');
const ParkingSpot = require('../../src/models/ParkingSpot');
const BookingController = require('../../src/controllers/bookingController');

const makeRes = () => ({
  statusCode: 200, body: null,
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
});

const FINDER = 5;
const OWNER = 7;
const STRANGER = 99;

beforeEach(() => {
  jest.clearAllMocks();
  Booking.findById.mockResolvedValue({ id: 100, user_id: FINDER, spot_id: 9, total_price: 400 });
  ParkingSpot.findById.mockResolvedValue({ id: 9, spotter_id: OWNER });
  // The finder is ₹300 in arrears from an earlier unpaid booking.
  prisma.users.findUnique.mockResolvedValue({ id: FINDER, balance: -300 });
});

const call = async (userId, role) => {
  const res = makeRes();
  await BookingController.getCheckoutAmount(
    { user: { id: userId, role }, params: { id: '100' } },
    res
  );
  return res;
};

describe('who may read a booking-s checkout amount', () => {
  test('an unrelated user is refused', async () => {
    const res = await call(STRANGER, 'finder');
    expect(res.statusCode).toBe(403);
    expect(res.body.data).toBeUndefined();
  });

  test('being a spotter is not enough — it must be YOUR spot', async () => {
    const res = await call(STRANGER, 'spotter');
    expect(res.statusCode).toBe(403);
  });

  test('the finder on the booking sees their own full breakdown', async () => {
    const res = await call(FINDER, 'finder');
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({ base_price: 400, arrears: 300, total_amount: 700 });
  });

  test('the spot owner gets the total to collect but not the arrears figure', async () => {
    const res = await call(OWNER, 'spotter');
    expect(res.statusCode).toBe(200);
    expect(res.body.data.total_amount).toBe(700);
    // They need the number the QR charges; they do not need to know this rider
    // owes money elsewhere on ParkStop.
    expect(res.body.data.arrears).toBeUndefined();
    expect(res.body.data.includes_arrears).toBe(true);
  });

  test('a missing booking is a 404, not a leak of whether the id exists', async () => {
    Booking.findById.mockResolvedValue(null);
    const res = await call(STRANGER, 'finder');
    expect(res.statusCode).toBe(404);
  });
});
