/**
 * Unit tests for the Booking model — the highest-risk money/state logic.
 *
 * Prisma, the pricing/payment services, and the logger are mocked, so these run
 * with NO database. Run with:
 *   npx jest tests/unit/booking.model.test.js
 *
 * Focus areas:
 *   - verifyOTP: constant-time OTP check, attempt lockout, expiry, state guards
 *   - create:    slot availability, duration validation, price + commission wiring
 *   - cancel:    only reserved bookings can be cancelled; slots are returned
 *
 * CommissionService is intentionally NOT mocked — it is a pure, already-tested
 * function, so we let the real math run to catch wiring mistakes.
 */

// ---- Mocks ---------------------------------------------------------------

// A single transaction-scoped mock reused by prisma.$transaction(cb => cb(tx)).
const mockTx = {
  $executeRaw: jest.fn(),
  bookings: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  parking_spots: { findUnique: jest.fn(), update: jest.fn() },
  users: { update: jest.fn() },
};

jest.mock('../../src/config/prisma', () => ({
  $transaction: jest.fn((cb) => cb(mockTx)),
  bookings: { findUnique: jest.fn(), findMany: jest.fn() },
  parking_spots: { findUnique: jest.fn() },
  users: { update: jest.fn() },
}));

jest.mock('../../src/services/PricingService', () => ({
  calculatePrice: jest.fn().mockResolvedValue({ finalPrice: 100 }),
}));

// Payment/notification side-effects are stubbed — we only test booking logic here.
jest.mock('../../src/services/paymentService', () => ({
  chargeUserForBooking: jest.fn().mockResolvedValue({ success: false }),
  splitAndPayout: jest.fn().mockResolvedValue({}),
}));

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const Booking = require('../../src/models/Booking');

const future = () => new Date(Date.now() + 30 * 60 * 1000);
const past = () => new Date(Date.now() - 60 * 1000);

beforeEach(() => {
  jest.clearAllMocks();
});

// ---- verifyOTP -----------------------------------------------------------

describe('Booking.verifyOTP', () => {
  const reservedBooking = (overrides = {}) => ({
    id: 1,
    status: 'reserved',
    otp_code: '123456',
    otp_attempts: 0,
    otp_expires_at: future(),
    ...overrides,
  });

  test('valid OTP activates the booking and resets attempts', async () => {
    mockTx.bookings.findUnique.mockResolvedValue(reservedBooking());
    mockTx.bookings.update.mockResolvedValue({ id: 1, status: 'active' });

    const result = await Booking.verifyOTP(1, '123456');

    expect(result.status).toBe('active');
    expect(mockTx.bookings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'active', otp_attempts: 0 }),
      })
    );
  });

  test('invalid OTP increments the attempt counter and throws', async () => {
    mockTx.bookings.findUnique.mockResolvedValue(reservedBooking({ otp_attempts: 1 }));

    await expect(Booking.verifyOTP(1, '000000')).rejects.toThrow('Invalid OTP');
    expect(mockTx.bookings.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { otp_attempts: 2 } })
    );
  });

  test('locks after 3 failed attempts (before checking the code)', async () => {
    mockTx.bookings.findUnique.mockResolvedValue(reservedBooking({ otp_attempts: 3 }));
    await expect(Booking.verifyOTP(1, '123456')).rejects.toThrow(/locked/i);
    expect(mockTx.bookings.update).not.toHaveBeenCalled();
  });

  test('rejects an expired OTP', async () => {
    mockTx.bookings.findUnique.mockResolvedValue(reservedBooking({ otp_expires_at: past() }));
    await expect(Booking.verifyOTP(1, '123456')).rejects.toThrow('OTP expired');
  });

  test('rejects when booking is not in reserved state', async () => {
    mockTx.bookings.findUnique.mockResolvedValue(reservedBooking({ status: 'active' }));
    await expect(Booking.verifyOTP(1, '123456')).rejects.toThrow('Booking is not reserved');
  });

  test('rejects when booking does not exist', async () => {
    mockTx.bookings.findUnique.mockResolvedValue(null);
    await expect(Booking.verifyOTP(999, '123456')).rejects.toThrow('Booking not found');
  });
});

// ---- create --------------------------------------------------------------

describe('Booking.create', () => {
  const activeSpot = (overrides = {}) => ({
    id: 10,
    is_active: true,
    available_slots: 2,
    car_slots: 1,
    bike_slots: 0,
    total_slots: 2,
    price_per_hour: 50,
    location_type: 'urban',
    ...overrides,
  });

  const validWindow = () => {
    const base = Date.now();
    return {
      start_time: new Date(base + 60 * 1000).toISOString(),
      end_time: new Date(base + 60 * 1000 + 2 * 60 * 60 * 1000).toISOString(), // exactly 2h
    };
  };

  test('creates a reserved booking with price, commission split, and a 6-digit OTP', async () => {
    mockTx.parking_spots.findUnique.mockResolvedValue(activeSpot());
    mockTx.bookings.create.mockImplementation(({ data }) => Promise.resolve({ id: 1, ...data }));
    mockTx.parking_spots.update.mockResolvedValue({});

    const booking = await Booking.create({
      user_id: 1, spot_id: 10, vehicle_type: 'car', ...validWindow(),
    });

    const created = mockTx.bookings.create.mock.calls[0][0].data;
    expect(created.status).toBe('reserved');
    expect(created.total_price).toBe(200);      // 2h * finalPrice(100)
    expect(created.platform_fee).toBe(40);       // urban 20% of 200
    expect(created.spotter_earning).toBe(160);
    expect(created.payment_status).toBe('pending'); // online default
    expect(created.otp_code).toMatch(/^\d{6}$/);
    expect(created.checkout_otp).toMatch(/^\d{6}$/);

    // Slot was decremented
    expect(mockTx.parking_spots.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ available_slots: { decrement: 1 } }),
      })
    );
    expect(booking.status).toBe('reserved');
  });

  test('cash bookings are marked pending_cash', async () => {
    mockTx.parking_spots.findUnique.mockResolvedValue(activeSpot());
    mockTx.bookings.create.mockImplementation(({ data }) => Promise.resolve({ id: 1, ...data }));
    mockTx.parking_spots.update.mockResolvedValue({});

    await Booking.create({ user_id: 1, spot_id: 10, payment_mode: 'cash', ...validWindow() });

    expect(mockTx.bookings.create.mock.calls[0][0].data.payment_status).toBe('pending_cash');
  });

  test('rejects when no slots are available', async () => {
    mockTx.parking_spots.findUnique.mockResolvedValue(activeSpot({ available_slots: 0, car_slots: 1 }));
    await expect(
      Booking.create({ user_id: 1, spot_id: 10, vehicle_type: 'car', ...validWindow() })
    ).rejects.toThrow('No total slots available');
    expect(mockTx.bookings.create).not.toHaveBeenCalled();
  });

  test('rejects an inactive / missing spot', async () => {
    mockTx.parking_spots.findUnique.mockResolvedValue(activeSpot({ is_active: false }));
    await expect(
      Booking.create({ user_id: 1, spot_id: 10, ...validWindow() })
    ).rejects.toThrow('Parking spot not found');
  });

  test('rejects an invalid duration (end <= start)', async () => {
    mockTx.parking_spots.findUnique.mockResolvedValue(activeSpot());
    const now = new Date().toISOString();
    await expect(
      Booking.create({ user_id: 1, spot_id: 10, start_time: now, end_time: now })
    ).rejects.toThrow('Invalid booking duration');
  });
});

// ---- cancel --------------------------------------------------------------

describe('Booking.cancel', () => {
  test('cancels a reserved booking and returns the slot', async () => {
    mockTx.bookings.findFirst.mockResolvedValue({
      id: 1, status: 'reserved', spot_id: 10, vehicle_type: 'car', parking_spots: { id: 10 },
    });
    mockTx.bookings.update.mockResolvedValue({});
    mockTx.parking_spots.update.mockResolvedValue({});

    await Booking.cancel(1, 1);

    expect(mockTx.bookings.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'cancelled' }) })
    );
    expect(mockTx.parking_spots.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ available_slots: { increment: 1 } }),
      })
    );
  });

  test('refuses to cancel a non-reserved booking', async () => {
    mockTx.bookings.findFirst.mockResolvedValue({
      id: 1, status: 'active', spot_id: 10, parking_spots: { id: 10 },
    });
    await expect(Booking.cancel(1, 1)).rejects.toThrow('Only reserved bookings can be cancelled');
    expect(mockTx.parking_spots.update).not.toHaveBeenCalled();
  });

  test('throws when booking is not found', async () => {
    mockTx.bookings.findFirst.mockResolvedValue(null);
    await expect(Booking.cancel(999, 1)).rejects.toThrow('Booking not found');
  });
});
