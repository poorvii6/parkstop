/**
 * The proximity search had one question and five answers.
 *
 * The map asked for 10 km, the place-search asked for 1000, an unused hook
 * asked for 50, and both backends defaulted to 5 — so whether a spot existed
 * depended on which screen you were looking at. These tests pin the single
 * radius and the two guards around it.
 */
jest.mock('../../src/config/prisma', () => ({
  parking_spots: {},
  bookings: {},
}));
jest.mock('../../src/models/ParkingSpot', () => ({
  findNearby: jest.fn(),
  findAbsoluteNearest: jest.fn(),
  SEARCH_RADIUS_KM: 2,
  FALLBACK_RADIUS_KM: 10,
}));
jest.mock('../../src/services/PricingService', () => ({
  calculatePrice: jest.fn(async ({ basePrice }) => ({
    finalPrice: basePrice, multiplier: 1.0, breakdown: {},
  })),
}));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const ParkingSpot = require('../../src/models/ParkingSpot');
const SpotController = require('../../src/controllers/spotController');

const makeRes = () => ({
  statusCode: 200, body: null,
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
});

const spot = (id, distance) => ({
  id, title: `Spot ${id}`, price_per_hour: 40, location_type: 'urban',
  latitude: 12.9, longitude: 77.6, distance, available_slots: 3, total_slots: 4,
});

const call = async (query) => {
  const res = makeRes();
  await SpotController.getNearbySpots({ query }, res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  ParkingSpot.findNearby.mockResolvedValue([spot(1, 0.4)]);
  ParkingSpot.findAbsoluteNearest.mockResolvedValue([]);
});

describe('the radius a finder actually gets', () => {
  test('with no radius given, the search is 2 km — not 5', async () => {
    await call({ lat: '12.9', lng: '77.6' });
    expect(ParkingSpot.findNearby).toHaveBeenCalledWith(12.9, 77.6, 2);
  });

  test('a client may narrow the search', async () => {
    await call({ lat: '12.9', lng: '77.6', radius: '1' });
    expect(ParkingSpot.findNearby).toHaveBeenCalledWith(12.9, 77.6, 1);
  });

  test('the 1000 km place-search request is clamped, not honoured', async () => {
    await call({ lat: '12.9', lng: '77.6', radius: '1000' });
    const [, , used] = ParkingSpot.findNearby.mock.calls[0];
    expect(used).toBe(25);
  });

  test('a junk radius falls back to the default rather than NaN', async () => {
    await call({ lat: '12.9', lng: '77.6', radius: 'abc' });
    expect(ParkingSpot.findNearby).toHaveBeenCalledWith(12.9, 77.6, 2);
    await call({ lat: '12.9', lng: '77.6', radius: '-5' });
    expect(ParkingSpot.findNearby).toHaveBeenLastCalledWith(12.9, 77.6, 2);
  });
});

describe('when nothing is in range', () => {
  beforeEach(() => { ParkingSpot.findNearby.mockResolvedValue([]); });

  test('the fallback is asked for a bounded distance, not the whole country', async () => {
    ParkingSpot.findAbsoluteNearest.mockResolvedValue([spot(9, 6.2)]);
    await call({ lat: '12.9', lng: '77.6' });
    expect(ParkingSpot.findAbsoluteNearest).toHaveBeenCalledWith(12.9, 77.6, 5, 10);
  });

  test('the message states both distances so nobody drives an hour by accident', async () => {
    ParkingSpot.findAbsoluteNearest.mockResolvedValue([spot(9, 6.2)]);
    const res = await call({ lat: '12.9', lng: '77.6' });
    expect(res.body.message).toBe('No spots within 2 km. Showing the nearest within 10 km.');
    expect(res.body.count).toBe(1);
  });

  test('nothing within the fallback either says so, rather than offering Delhi', async () => {
    ParkingSpot.findAbsoluteNearest.mockResolvedValue([]);
    const res = await call({ lat: '12.9', lng: '77.6' });
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(0);
    expect(res.body.message).toBe('No spots available within 10 km.');
  });
});

describe('input guards', () => {
  test('a missing coordinate is a 400, not a search from (NaN, NaN)', async () => {
    const res = await call({ lng: '77.6' });
    expect(res.statusCode).toBe(400);
    expect(ParkingSpot.findNearby).not.toHaveBeenCalled();
  });
});
