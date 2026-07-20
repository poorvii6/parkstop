/**
 * Unit tests for SpotController.getEarningsBreakdown.
 *
 * This endpoint is what makes the Spotter wallet legible: it explains WHERE a
 * balance or a dues figure came from. The critical invariant it encodes is the
 * sign of `wallet_effect`:
 *
 *   cash booking   -> spotter already holds the money, so they OWE the platform
 *                     fee. Wallet effect is NEGATIVE (a debt).
 *   online booking -> platform holds the money, so the spotter is OWED their
 *                     share. Wallet effect is POSITIVE (a credit).
 *
 * Getting that sign backwards would silently invert every Spotter's balance,
 * so it is tested explicitly. Runs with NO database.
 *   npx jest tests/unit/spotController.earnings.test.js
 */

jest.mock('../../src/config/prisma', () => ({
  bookings: { findMany: jest.fn() },
  users: { findUnique: jest.fn() },
}));
jest.mock('../../src/models/ParkingSpot', () => ({ getSpotterDashboard: jest.fn() }));
jest.mock('../../src/services/PricingService', () => ({}));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const prisma = require('../../src/config/prisma');
const SpotController = require('../../src/controllers/spotController');

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const req = (query = {}) => ({ user: { id: 7, role: 'spotter' }, query });

/** A completed booking as Prisma would return it (with the spot joined in). */
const booking = (over = {}) => ({
  id: 1,
  hours: 2,
  total_price: 100,
  platform_fee: 20,
  spotter_earning: 80,
  payment_mode: 'online',
  payment_status: 'paid',
  created_at: new Date('2026-07-01T10:00:00Z'),
  actual_end_time: new Date('2026-07-01T12:00:00Z'),
  parking_spots: { id: 55, title: 'MG Road Basement' },
  ...over,
});

const payload = (res) => res.json.mock.calls[0][0].data;

beforeEach(() => jest.clearAllMocks());

describe('SpotController.getEarningsBreakdown', () => {
  describe('wallet effect sign', () => {
    it('treats a cash booking as a NEGATIVE wallet effect (fee owed)', async () => {
      prisma.bookings.findMany.mockResolvedValue([
        booking({ payment_mode: 'cash', platform_fee: 20, spotter_earning: 80 }),
      ]);
      const res = mockRes();

      await SpotController.getEarningsBreakdown(req(), res);

      const { items, totals } = payload(res);
      expect(items[0].wallet_effect).toBe(-20);
      expect(totals.cash_fees_owed).toBe(20);
    });

    it('treats an online booking as a POSITIVE wallet effect (earning credited)', async () => {
      prisma.bookings.findMany.mockResolvedValue([
        booking({ payment_mode: 'online', platform_fee: 20, spotter_earning: 80 }),
      ]);
      const res = mockRes();

      await SpotController.getEarningsBreakdown(req(), res);

      const { items, totals } = payload(res);
      expect(items[0].wallet_effect).toBe(80);
      // Online fees are already netted off by the platform, never owed.
      expect(totals.cash_fees_owed).toBe(0);
    });
  });

  describe('totals', () => {
    it('sums gross, fees and earnings across mixed payment modes', async () => {
      prisma.bookings.findMany.mockResolvedValue([
        booking({ id: 1, total_price: 100, platform_fee: 20, spotter_earning: 80, payment_mode: 'online' }),
        booking({ id: 2, total_price: 50, platform_fee: 7.5, spotter_earning: 42.5, payment_mode: 'cash' }),
      ]);
      const res = mockRes();

      await SpotController.getEarningsBreakdown(req(), res);

      const { totals } = payload(res);
      expect(totals.gross).toBe(150);
      expect(totals.fees).toBe(27.5);
      expect(totals.earnings).toBe(122.5);
      expect(totals.bookings).toBe(2);
      // Only the cash booking's fee is a debt.
      expect(totals.cash_fees_owed).toBe(7.5);
    });

    it('avoids floating-point drift in the totals it reports', async () => {
      // 0.1 + 0.2 style money that would otherwise surface as 0.30000000000000004
      prisma.bookings.findMany.mockResolvedValue([
        booking({ id: 1, total_price: 0.1, platform_fee: 0.1, spotter_earning: 0.1 }),
        booking({ id: 2, total_price: 0.2, platform_fee: 0.2, spotter_earning: 0.2 }),
      ]);
      const res = mockRes();

      await SpotController.getEarningsBreakdown(req(), res);

      expect(payload(res).totals.gross).toBe(0.3);
    });

    it('returns zeroed totals rather than failing when there are no bookings', async () => {
      prisma.bookings.findMany.mockResolvedValue([]);
      const res = mockRes();

      await SpotController.getEarningsBreakdown(req(), res);

      const { totals, items, by_spot } = payload(res);
      expect(totals).toEqual({ gross: 0, fees: 0, earnings: 0, cash_fees_owed: 0, bookings: 0 });
      expect(items).toEqual([]);
      expect(by_spot).toEqual([]);
    });
  });

  describe('per-spot rollup', () => {
    it('groups bookings by spot and ranks by earnings descending', async () => {
      prisma.bookings.findMany.mockResolvedValue([
        booking({ id: 1, spotter_earning: 10, total_price: 20, platform_fee: 10, parking_spots: { id: 1, title: 'Quiet Lane' } }),
        booking({ id: 2, spotter_earning: 90, total_price: 100, platform_fee: 10, parking_spots: { id: 2, title: 'Busy Mall' } }),
        booking({ id: 3, spotter_earning: 40, total_price: 50, platform_fee: 10, parking_spots: { id: 2, title: 'Busy Mall' } }),
      ]);
      const res = mockRes();

      await SpotController.getEarningsBreakdown(req(), res);

      const { by_spot } = payload(res);
      expect(by_spot).toHaveLength(2);
      // Busy Mall (90 + 40) must outrank Quiet Lane (10).
      expect(by_spot[0].spot_title).toBe('Busy Mall');
      expect(by_spot[0].bookings).toBe(2);
      expect(by_spot[0].earnings).toBe(130);
      expect(by_spot[1].spot_title).toBe('Quiet Lane');
    });

    it('does not crash when a booking has lost its spot relation', async () => {
      prisma.bookings.findMany.mockResolvedValue([booking({ parking_spots: null })]);
      const res = mockRes();

      await SpotController.getEarningsBreakdown(req(), res);

      const { items, by_spot } = payload(res);
      expect(items[0].spot_title).toBe('Spot');
      expect(by_spot[0].bookings).toBe(1);
    });
  });

  describe('query scoping', () => {
    it('only counts completed bookings belonging to the calling spotter', async () => {
      prisma.bookings.findMany.mockResolvedValue([]);

      await SpotController.getEarningsBreakdown(req(), mockRes());

      const { where } = prisma.bookings.findMany.mock.calls[0][0];
      expect(where.status).toBe('completed');
      expect(where.parking_spots.spotter_id).toBe(7);
    });

    it('caps the window at one year so a huge ?days cannot scan the table', async () => {
      prisma.bookings.findMany.mockResolvedValue([]);
      const res = mockRes();

      await SpotController.getEarningsBreakdown(req({ days: '99999' }), res);

      expect(payload(res).period_days).toBe(365);
    });

    it('defaults to a 30 day window when ?days is absent or junk', async () => {
      prisma.bookings.findMany.mockResolvedValue([]);
      const res = mockRes();

      await SpotController.getEarningsBreakdown(req({ days: 'abc' }), res);

      expect(payload(res).period_days).toBe(30);
    });
  });

  it('responds 500 without leaking internals when the database fails', async () => {
    prisma.bookings.findMany.mockRejectedValue(new Error('connection reset'));
    const res = mockRes();

    await SpotController.getEarningsBreakdown(req(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json.mock.calls[0][0].success).toBe(false);
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toMatch(/connection reset/);
  });
});
