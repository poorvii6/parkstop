/**
 * Unit tests for AnalyticsController — the BigInt serialization trap.
 *
 * Postgres COUNT() is bigint. Prisma hands a bigint back as a JS BigInt, and
 * JSON.stringify — which is what res.json() does — throws on one:
 *
 *   Do not know how to serialize a BigInt
 *     at JSON.stringify
 *     at getPlatformAnalytics (analyticsController.js:88)
 *   GET /api/v1/analytics/platform  500
 *
 * Every call failed. The admin dashboard showed a spinner that never stopped,
 * because nothing on the client distinguished "still loading" from "the request
 * died". The fix is the convention already used in ParkingSpot.findNearby:
 * cast the count in SQL, `COUNT(...)::int`.
 *
 * SUM is deliberately NOT cast. The money columns are numeric(10,2), so they
 * arrive as Prisma Decimals and serialize to strings, which is the form the
 * clients parseFloat. Casting them to ::float would silently change the wire
 * type and reintroduce binary-float rounding into money.
 *
 * Two guards here:
 *   1. the SQL itself — no uncast COUNT may reach the database
 *   2. the response — the payload must survive JSON.stringify
 *
 * Runs with NO database.
 *   npx jest tests/unit/analyticsController.serialization.test.js
 */

jest.mock('../../src/config/prisma', () => ({ $queryRaw: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const prisma = require('../../src/config/prisma');
const AnalyticsController = require('../../src/controllers/analyticsController');

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

/**
 * $queryRaw is a tagged template, so the mock receives the array of literal
 * chunks. Joining them back gives the SQL with the interpolations removed,
 * which is all these assertions need.
 */
const sqlOf = (call) => (Array.isArray(call[0]) ? call[0].join('?') : String(call[0]));
const allSql = () => prisma.$queryRaw.mock.calls.map(sqlOf);

/**
 * Every endpoint, with the arguments it needs. Kept as a list so a new
 * analytics endpoint that forgets the cast is caught by the same loop.
 */
const ENDPOINTS = [
  {
    name: 'getPlatformAnalytics',
    run: (res) => AnalyticsController.getPlatformAnalytics({}, res),
  },
  {
    name: 'getTopSpotters',
    run: (res) => AnalyticsController.getTopSpotters({}, res),
  },
  {
    name: 'getSpotterAnalytics',
    run: (res) => AnalyticsController.getSpotterAnalytics(
      { params: { spotterId: '7' }, user: { id: 7, role: 'SPOTTER' } },
      res,
    ),
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  // One row, shaped the way a cast query really comes back: counts as numbers,
  // money as the string a Prisma Decimal serializes to.
  prisma.$queryRaw.mockResolvedValue([
    { total_bookings: 3, total_completed_bookings: 2, total_revenue: '120.00' },
  ]);
});

describe('AnalyticsController SQL', () => {
  describe.each(ENDPOINTS)('$name', ({ run }) => {
    it('casts every COUNT to ::int', async () => {
      await run(mockRes());
      const sql = allSql();
      expect(sql.length).toBeGreaterThan(0);

      for (const q of sql) {
        // Each COUNT(...) in the query, with whatever follows it on the line.
        // A FILTER clause may sit between the count and the cast.
        const counts = q.match(/COUNT\s*\([^)]*\)(\s*FILTER\s*\([^)]*\))?[^,\n]*/gi) || [];
        for (const c of counts) {
          expect(c).toMatch(/::int\b/i);
        }
      }
    });

    it('does not cast SUM, so money stays numeric', async () => {
      await run(mockRes());
      for (const q of allSql()) {
        const sums = q.match(/SUM\s*\([^)]*\)(\s*FILTER\s*\([^)]*\))?[^,\n]*/gi) || [];
        for (const s of sums) {
          expect(s).not.toMatch(/::(int|float|double|real)\b/i);
        }
      }
    });
  });

  it('finds the counts it claims to be checking', async () => {
    // Guards the regexes above: if they stopped matching anything, every
    // assertion in this file would pass over an empty list and prove nothing.
    await AnalyticsController.getPlatformAnalytics({}, mockRes());
    const counts = allSql().join('\n').match(/COUNT\s*\(/gi) || [];
    expect(counts.length).toBeGreaterThanOrEqual(2);
  });
});

describe('AnalyticsController responses', () => {
  describe.each(ENDPOINTS)('$name', ({ run }) => {
    it('returns a payload res.json() can serialize', async () => {
      const res = mockRes();
      await run(res);
      expect(res.json).toHaveBeenCalled();
      expect(() => JSON.stringify(res.json.mock.calls[0][0])).not.toThrow();
      expect(res.status).not.toHaveBeenCalledWith(500);
    });

    it('is defenceless against a BigInt, which is why the cast is the fix', async () => {
      // The controller does not sanitize the rows — nothing walks the payload
      // converting BigInts. The ::int in the SQL is the whole defence. This
      // test pins that down: hand the controller a BigInt and the response is
      // unserializable, exactly as production was. If someone later adds a
      // serializer and this starts failing, that is a real change in design
      // and the comment above `getSpotterAnalytics` should be updated with it.
      prisma.$queryRaw.mockResolvedValue([{ total_bookings: BigInt(3) }]);
      const res = mockRes();
      await run(res);
      expect(() => JSON.stringify(res.json.mock.calls[0][0])).toThrow(/BigInt/);
    });
  });
});
