/**
 * The four spotter-dashboard corrections.
 * Pure logic where possible; prisma mocked where a query is unavoidable.
 */
jest.mock('../../src/config/prisma', () => ({
  parking_spots: { count: jest.fn(), findMany: jest.fn() },
  bookings: { aggregate: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  payouts: { findMany: jest.fn() },
}));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const prisma = require('../../src/config/prisma');
const PricingService = require('../../src/services/PricingService');
const ParkingSpot = require('../../src/models/ParkingSpot');

describe('surge tiers are one definition, usable without a query', () => {
  test.each([
    [10, 10, 2.0],
    [9, 10, 1.5],
    [7, 10, 1.2],
    [5, 10, 1.1],
    [1, 10, 1.0],
  ])('%i of %i slots busy -> %fx', (active, slots, expected) => {
    expect(PricingService.demandMultiplierFor(active, slots)).toBe(expected);
  });

  test('no slots cannot divide by zero', () => {
    expect(PricingService.demandMultiplierFor(3, 0)).toBe(1.0);
  });
});

describe('getSpotterDashboard', () => {
  const IST = (5 * 60 + 30) * 60 * 1000;
  const daysAgoIst = (n) => new Date(Date.now() - n * 86400000);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.parking_spots.count.mockResolvedValue(2);
    prisma.parking_spots.findMany
      .mockResolvedValueOnce([                       // activeSpots
        { id: 1, title: 'A', total_slots: 10, available_slots: 5 },
        { id: 2, title: 'B', total_slots: 10, available_slots: 10 },
      ])
      .mockResolvedValueOnce([{ is_active: true }]); // allSpots (global online)
    prisma.bookings.groupBy.mockResolvedValue([{ spot_id: 1, _count: { _all: 9 } }]);
    prisma.bookings.findMany.mockResolvedValue([]);
    prisma.payouts.findMany.mockResolvedValue([]);
    prisma.bookings.aggregate.mockResolvedValue({ _sum: { spotter_earning: 0 }, _avg: { hours: 0 } });
  });

  test('surge uses ONE grouped query, not one per spot', async () => {
    await ParkingSpot.getSpotterDashboard(7);
    expect(prisma.bookings.groupBy).toHaveBeenCalledTimes(1);
  });

  test('earnings exclude money never collected, and report it separately', async () => {
    prisma.bookings.aggregate
      .mockResolvedValueOnce({ _sum: { spotter_earning: 800 } })  // settled
      .mockResolvedValueOnce({ _sum: { spotter_earning: 250 } })  // pending
      .mockResolvedValueOnce({ _avg: { hours: 2 } });             // avg duration

    const d = await ParkingSpot.getSpotterDashboard(7);
    expect(d.earnings).toBe(800);           // not 1050
    expect(d.pending_earnings).toBe(250);
  });

  test('trend buckets by COMPLETION time, not creation', async () => {
    prisma.bookings.aggregate
      .mockResolvedValueOnce({ _sum: { spotter_earning: 0 } })
      .mockResolvedValueOnce({ _sum: { spotter_earning: 0 } })
      .mockResolvedValueOnce({ _avg: { hours: 0 } });
    // Created 5 days ago, finished today -> belongs to TODAY (last bucket).
    prisma.bookings.findMany.mockResolvedValue([
      { created_at: daysAgoIst(5), actual_end_time: new Date(), spotter_earning: 120 },
    ]);

    const d = await ParkingSpot.getSpotterDashboard(7);
    expect(d.revenue_trend[6]).toBe(120);   // today
    expect(d.revenue_trend[1]).toBe(0);     // not 5 days ago
  });

  test('older rows with no completion time still count', async () => {
    prisma.bookings.aggregate
      .mockResolvedValueOnce({ _sum: { spotter_earning: 0 } })
      .mockResolvedValueOnce({ _sum: { spotter_earning: 0 } })
      .mockResolvedValueOnce({ _avg: { hours: 0 } });
    prisma.bookings.findMany.mockResolvedValue([
      { created_at: new Date(), actual_end_time: null, spotter_earning: 60 },
    ]);

    const d = await ParkingSpot.getSpotterDashboard(7);
    expect(d.revenue_trend[6]).toBe(60);
  });
});
