/**
 * Unit tests for the money-moving checkout paths in BookingController:
 *   - checkoutCash    : mark paid + deduct the platform fee from the spotter's wallet
 *   - checkoutUnpaid  : arrears — credit the spotter their share, penalize the finder
 *
 * Everything external is mocked, so these run with NO database. Run with:
 *   npx jest tests/unit/bookingController.checkout.test.js
 *
 * CommissionService is left real (pure, already tested) to verify the wiring.
 */

jest.mock('../../src/models/Booking', () => ({ findById: jest.fn() }));
jest.mock('../../src/models/ParkingSpot', () => ({ findById: jest.fn() }));
jest.mock('../../src/config/prisma', () => ({
  $transaction: jest.fn(),
  bookings: { update: jest.fn() },
  users: { update: jest.fn() },
}));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
// Mock the controller's other heavy imports so requiring it is side-effect free.
jest.mock('../../src/services/paymentService', () => ({}));
jest.mock('../../src/services/notificationService', () => ({}));
jest.mock('../../src/config/socket', () => ({ emitToUser: jest.fn() }));
jest.mock('../../src/services/payments/PayoutService', () => ({}));
jest.mock('../../src/services/payments/BookingSettlementService', () => ({ settleCompletedBooking: jest.fn() }));

const Booking = require('../../src/models/Booking');
const ParkingSpot = require('../../src/models/ParkingSpot');
const prisma = require('../../src/config/prisma');
const BookingController = require('../../src/controllers/bookingController');

// Minimal Express req/res doubles.
const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};
const spotterReq = (overrides = {}) => ({
  user: { id: 7, role: 'spotter' },
  params: { id: '100' },
  body: {},
  ...overrides,
});

// Transaction-scoped mock reused by prisma.$transaction(cb => cb(tx)).
const tx = { bookings: { update: jest.fn() }, users: { update: jest.fn() } };

beforeEach(() => {
  jest.clearAllMocks();
  prisma.$transaction.mockImplementation((cb) => cb(tx));
});

// ---- checkoutCash --------------------------------------------------------

describe('BookingController.checkoutCash', () => {
  test('rejects non-spotters with 403', async () => {
    const req = spotterReq({ user: { id: 7, role: 'finder' } });
    const res = mockRes();
    await BookingController.checkoutCash(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('returns 404 when the booking does not exist', async () => {
    Booking.findById.mockResolvedValue(null);
    const res = mockRes();
    await BookingController.checkoutCash(spotterReq(), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('rejects a spotter who does not own the spot', async () => {
    Booking.findById.mockResolvedValue({ id: 100, total_price: 1000, spot_id: 5 });
    ParkingSpot.findById.mockResolvedValue({ spotter_id: 999, location_type: 'urban' });
    const res = mockRes();
    await BookingController.checkoutCash(spotterReq(), res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('marks paid and deducts the platform fee from the spotter wallet', async () => {
    Booking.findById.mockResolvedValue({ id: 100, total_price: 1000, spot_id: 5 });
    ParkingSpot.findById.mockResolvedValue({ spotter_id: 7, location_type: 'urban' });
    tx.bookings.update.mockResolvedValue({ id: 100, status: 'completed', payment_mode: 'cash' });
    const res = mockRes();

    await BookingController.checkoutCash(spotterReq(), res);

    // Booking updated to completed/paid/cash with the commission split (urban 20% of 1000)
    expect(tx.bookings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'completed',
          payment_status: 'paid',
          payment_mode: 'cash',
          platform_fee: 200,
          spotter_earning: 800,
        }),
      })
    );
    // Platform fee (200) deducted from the spotter's wallet
    expect(tx.users.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 7 },
        data: { balance: { decrement: 200 } },
      })
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true })
    );
  });

  test('does not touch the wallet when the fee is zero (free booking)', async () => {
    Booking.findById.mockResolvedValue({ id: 100, total_price: 0, spot_id: 5 });
    ParkingSpot.findById.mockResolvedValue({ spotter_id: 7, location_type: 'urban' });
    tx.bookings.update.mockResolvedValue({ id: 100 });
    const res = mockRes();

    await BookingController.checkoutCash(spotterReq(), res);

    expect(tx.users.update).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});

// ---- checkoutUnpaid (arrears) -------------------------------------------

describe('BookingController.checkoutUnpaid', () => {
  test('rejects non-spotters with 403', async () => {
    const req = spotterReq({ user: { id: 7, role: 'finder' } });
    const res = mockRes();
    await BookingController.checkoutUnpaid(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('returns 400 for an already completed or paid booking', async () => {
    Booking.findById.mockResolvedValue({ id: 100, status: 'completed', payment_status: 'paid' });
    const res = mockRes();
    await BookingController.checkoutUnpaid(spotterReq(), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects a spotter who does not own the spot', async () => {
    Booking.findById.mockResolvedValue({ id: 100, status: 'active', payment_status: 'pending', spot_id: 5 });
    ParkingSpot.findById.mockResolvedValue({ spotter_id: 999, location_type: 'urban' });
    const res = mockRes();
    await BookingController.checkoutUnpaid(spotterReq(), res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('credits the spotter their share and deducts the full amount from the finder', async () => {
    Booking.findById.mockResolvedValue({
      id: 100, status: 'active', payment_status: 'pending', total_price: 1000, spot_id: 5, user_id: 9,
    });
    ParkingSpot.findById.mockResolvedValue({ spotter_id: 7, location_type: 'urban' });
    tx.bookings.update.mockResolvedValue({ id: 100, total_price: 1000, payment_status: 'unpaid_arrears' });
    const res = mockRes();

    await BookingController.checkoutUnpaid(spotterReq(), res);

    // Booking marked completed + unpaid_arrears
    expect(tx.bookings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'completed', payment_status: 'unpaid_arrears' }),
      })
    );
    // Spotter credited their 80% share (800), finder penalized the full 1000
    expect(tx.users.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7 }, data: { balance: { increment: 800 } } })
    );
    expect(tx.users.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 9 }, data: { balance: { decrement: 1000 } } })
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});
