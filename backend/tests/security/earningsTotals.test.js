/**
 * The earnings screen must never understate money.
 *
 * The ledger sent to the app is a 200-row page. The TOTALS must still describe
 * the whole period — previously the query itself was capped at 200, so the
 * totals only covered the most recent 200 bookings while the screen said "in
 * the last 30 days".
 */
jest.mock('../../src/config/prisma', () => ({
  bookings: { findMany: jest.fn() },
}));
jest.mock('../../src/models/ParkingSpot', () => ({}));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const prisma = require('../../src/config/prisma');
const SpotController = require('../../src/controllers/spotController');

const makeRes = () => ({
  statusCode: 200, body: null,
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
});

test('340 bookings: totals cover all of them, list is paged and says so', async () => {
  prisma.bookings.findMany.mockResolvedValue(
    Array.from({ length: 340 }, (_, i) => ({
      id: i, hours: 1, total_price: 100, platform_fee: 20, spotter_earning: 80,
      payment_mode: 'online', payment_status: 'paid',
      created_at: new Date(0), actual_end_time: new Date(0),
      parking_spots: { id: 1, title: 'Driveway' },
    }))
  );

  const res = makeRes();
  await SpotController.getEarningsBreakdown({ user: { id: 7, role: 'spotter' }, query: { days: 30 } }, res);
  const d = res.body.data;

  // All 340 × ₹80 = ₹27,200 — NOT the 200-row page (₹16,000).
  expect(d.totals.earnings).toBe(27200);
  expect(d.totals.bookings).toBe(340);
  expect(d.by_spot[0].earnings).toBe(27200);

  // Payload stays bounded, and is honest about it.
  expect(d.items.length).toBe(200);
  expect(d.items_truncated).toBe(true);
  expect(d.items_shown).toBe(200);
});

test('under the page size, nothing is flagged as truncated', async () => {
  prisma.bookings.findMany.mockResolvedValue(
    Array.from({ length: 3 }, (_, i) => ({
      id: i, hours: 1, total_price: 100, platform_fee: 20, spotter_earning: 80,
      payment_mode: 'cash', payment_status: 'paid',
      created_at: new Date(0), actual_end_time: new Date(0),
      parking_spots: { id: 2, title: 'Garage' },
    }))
  );

  const res = makeRes();
  await SpotController.getEarningsBreakdown({ user: { id: 7, role: 'spotter' }, query: {} }, res);
  const d = res.body.data;

  expect(d.items.length).toBe(3);
  expect(d.items_truncated).toBe(false);
  // Cash fees are what the spotter owes the platform.
  expect(d.totals.cash_fees_owed).toBe(60);
});
