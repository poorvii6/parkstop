/**
 * Unit tests for PricingService — dynamic pricing multipliers.
 *
 * Prisma and the logger are mocked, so these run with NO database. Run with:
 *   npx jest tests/unit/pricingService.test.js
 *
 * Covers (from src/services/PricingService.js):
 *   - getTimeMultiplier      (time-of-day / weekday surge)
 *   - getLocationMultiplier  (urban / suburban / rural)
 *   - calculateDemandMultiplier (occupancy-based surge tiers)
 *   - calculatePrice         (composition + safe fallback on error)
 */

jest.mock('../../src/config/prisma', () => ({
  parking_spots: { findUnique: jest.fn() },
  bookings: { count: jest.fn() },
}));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const prisma = require('../../src/config/prisma');
const PricingService = require('../../src/services/PricingService');

// Build a fake Date-like object so tests don't depend on the machine's clock/timezone.
const clock = (day, hour) => ({ getDay: () => day, getHours: () => hour });

beforeEach(() => {
  jest.clearAllMocks();
  // Feature flags default OFF, matching production defaults.
  delete process.env.ENABLE_TIME_PRICING;
  delete process.env.ENABLE_LOCATION_PRICING;
});

describe('getTimeMultiplier', () => {
  test('weekday morning rush (Mon 8am) -> 1.3', () => {
    expect(PricingService.getTimeMultiplier(clock(1, 8))).toBe(1.3);
  });

  test('weekday evening rush (Tue 6pm) -> 1.4', () => {
    expect(PricingService.getTimeMultiplier(clock(2, 18))).toBe(1.4);
  });

  test('late night (Wed 11pm) -> 0.8', () => {
    expect(PricingService.getTimeMultiplier(clock(3, 23))).toBe(0.8);
  });

  test('early morning (Mon 3am) -> 0.8', () => {
    expect(PricingService.getTimeMultiplier(clock(1, 3))).toBe(0.8);
  });

  test('weekend afternoon (Sat 2pm) -> 1.2', () => {
    expect(PricingService.getTimeMultiplier(clock(6, 14))).toBe(1.2);
  });

  test('ordinary midday (Wed noon) -> 1.0', () => {
    expect(PricingService.getTimeMultiplier(clock(3, 12))).toBe(1.0);
  });
});

describe('getLocationMultiplier', () => {
  test.each([
    ['urban', 1.5],
    ['suburban', 1.2],
    ['rural', 0.9],
    ['unknown', 1.0],
    [undefined, 1.0],
  ])('%s -> %p', (type, expected) => {
    expect(PricingService.getLocationMultiplier(type)).toBe(expected);
  });
});

describe('calculateDemandMultiplier (occupancy tiers)', () => {
  test.each([
    [10, 10, 2.0], // 100% full
    [9, 10, 1.5],  // 90%
    [7, 10, 1.2],  // 70%
    [5, 10, 1.1],  // 50%
    [1, 10, 1.0],  // 10%
    [0, 10, 1.0],  // empty
  ])('%i active / %i slots -> %p', async (active, slots, expected) => {
    prisma.bookings.count.mockResolvedValue(active);
    await expect(PricingService.calculateDemandMultiplier(1, slots)).resolves.toBe(expected);
  });

  test('zero total slots does not divide-by-zero -> 1.0', async () => {
    prisma.bookings.count.mockResolvedValue(0);
    await expect(PricingService.calculateDemandMultiplier(1, 0)).resolves.toBe(1.0);
  });

  test('DB error falls back to 1.0', async () => {
    prisma.bookings.count.mockRejectedValue(new Error('db down'));
    await expect(PricingService.calculateDemandMultiplier(1, 10)).resolves.toBe(1.0);
  });
});

describe('calculatePrice', () => {
  test('no spotId, flags off -> price equals base', async () => {
    const r = await PricingService.calculatePrice({ basePrice: 100 });
    expect(r.finalPrice).toBe(100);
    expect(r.multiplier).toBe(1);
    expect(r.breakdown).toEqual({ time: 1, location: 1, demand: 1 });
  });

  test('applies demand surge when spot is busy', async () => {
    prisma.parking_spots.findUnique.mockResolvedValue({
      id: 5, price_per_hour: 100, location_type: 'urban', total_slots: 10,
    });
    prisma.bookings.count.mockResolvedValue(9); // 90% -> 1.5x
    const r = await PricingService.calculatePrice({ spotId: 5 });
    expect(r.finalPrice).toBe(150);
    expect(r.breakdown.demand).toBe(1.5);
  });

  test('safe fallback to 50 when spot lookup fails and no base given', async () => {
    prisma.parking_spots.findUnique.mockResolvedValue(null);
    const r = await PricingService.calculatePrice({ spotId: 999 });
    expect(r.finalPrice).toBe(50);
    expect(r.multiplier).toBe(1.0);
  });

  test('safe fallback uses provided base price on error', async () => {
    prisma.parking_spots.findUnique.mockResolvedValue(null);
    const r = await PricingService.calculatePrice({ basePrice: 80, spotId: 999 });
    expect(r.finalPrice).toBe(80);
  });
});
