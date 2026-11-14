/**
 * An owner cannot change what ParkStop earns, or set a nonsense price.
 *
 * TWO THINGS WERE OPEN on the spot write path:
 *
 * 1. location_type sets the commission rate. CommissionService charges 15% for
 *    'rural' against a 20% default, and both create and update passed the
 *    CALLER's own value into normalizeLocationType. An owner calling
 *    PUT /spots/:id directly could set 'rural' on their spot and cut
 *    ParkStop's fee on every booking of it — our revenue, chosen by the person
 *    collecting the other side of it. It is admin-only now.
 *
 * 2. price_per_hour had no validation on update at all:
 *    `price_per_hour ? parseFloat(...) : undefined` wrote -50 happily, and a
 *    non-numeric string became NaN. On create the controller's
 *    `!price || price <= 0` passes 'abc', because 'abc' <= 0 is false.
 *
 * Prisma and the logger are mocked; these run with no database.
 *
 *   npx jest tests/security/spotOwnerCannotSetCommission.test.js
 */
jest.mock('../../src/config/prisma', () => ({
  parking_spots: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  bookings: { groupBy: jest.fn(), count: jest.fn() },
  $queryRaw: jest.fn(),
}));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const prisma = require('../../src/config/prisma');
const logger = require('../../src/utils/logger');
const ParkingSpot = require('../../src/models/ParkingSpot');

/** The data Prisma was actually told to write. */
const written = (fn) => fn.mock.calls[0][0].data;

const NEW_SPOT = {
  spotter_id: 7,
  title: 'A bay',
  description: 'desc',
  price_per_hour: 40,
  latitude: 12.97,
  longitude: 77.59,
  address: '1 Test St',
  total_slots: 2,
  car_slots: 2,
  bike_slots: 0,
};

beforeEach(() => {
  jest.clearAllMocks();
  prisma.parking_spots.create.mockResolvedValue({ id: 1 });
  prisma.parking_spots.update.mockResolvedValue({ id: 1 });
});

describe('location_type is admin-only, because it sets the commission rate', () => {
  describe('on update', () => {
    test('a SPOTTER asking for rural does not change the column', async () => {
      await ParkingSpot.update(1, 7, { location_type: 'rural' }, 'SPOTTER');

      // undefined means Prisma leaves it as it is — the spot keeps whatever it had.
      expect(written(prisma.parking_spots.update).location_type).toBeUndefined();
    });

    test('the attempt is logged, so it is not invisible', async () => {
      await ParkingSpot.update(1, 7, { location_type: 'rural' }, 'SPOTTER');

      const warned = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toMatch(/location_type 'rural' requested by a non-admin/);
      expect(warned).toMatch(/commission rate/);
    });

    test('a FINDER cannot either', async () => {
      await ParkingSpot.update(1, 7, { location_type: 'rural' }, 'FINDER');
      expect(written(prisma.parking_spots.update).location_type).toBeUndefined();
    });

    test('no role given behaves as NOT an admin', async () => {
      // The parameter defaults to null, so a caller that forgets to pass the
      // role gets the safe behaviour rather than the permissive one.
      await ParkingSpot.update(1, 7, { location_type: 'rural' });
      expect(written(prisma.parking_spots.update).location_type).toBeUndefined();
    });

    test('an ADMIN CAN set it', async () => {
      await ParkingSpot.update(1, 7, { location_type: 'rural' }, 'ADMIN');
      expect(written(prisma.parking_spots.update).location_type).toBe('rural');
    });

    test("an admin's invalid value is still refused", async () => {
      // Admin-only does not mean unvalidated.
      await expect(
        ParkingSpot.update(1, 7, { location_type: 'free-for-me' }, 'ADMIN')
      ).rejects.toThrow(/Invalid location type/);
    });

    test('an owner sending urban back unchanged is not warned at', async () => {
      // The app may echo the current value; that is not an attempt at anything.
      await ParkingSpot.update(1, 7, { location_type: 'urban' }, 'SPOTTER');
      expect(logger.warn).not.toHaveBeenCalled();
    });

    test('everything else in the same body is still applied', async () => {
      // The guard must not swallow the rest of the update.
      await ParkingSpot.update(1, 7, { title: 'Renamed', location_type: 'rural' }, 'SPOTTER');

      const data = written(prisma.parking_spots.update);
      expect(data.title).toBe('Renamed');
      expect(data.location_type).toBeUndefined();
    });
  });

  describe('on create', () => {
    test("a SPOTTER's rural becomes urban", async () => {
      await ParkingSpot.create({ ...NEW_SPOT, location_type: 'rural' }, 'SPOTTER');
      expect(written(prisma.parking_spots.create).location_type).toBe('urban');
    });

    test('no role given behaves as NOT an admin', async () => {
      await ParkingSpot.create({ ...NEW_SPOT, location_type: 'rural' });
      expect(written(prisma.parking_spots.create).location_type).toBe('urban');
    });

    test('an ADMIN CAN set it', async () => {
      await ParkingSpot.create({ ...NEW_SPOT, location_type: 'rural' }, 'ADMIN');
      expect(written(prisma.parking_spots.create).location_type).toBe('rural');
    });

    test('a new spot with nothing asked for defaults to urban', async () => {
      await ParkingSpot.create({ ...NEW_SPOT }, 'SPOTTER');
      expect(written(prisma.parking_spots.create).location_type).toBe('urban');
    });
  });
});

describe('price_per_hour must be a positive finite number', () => {
  // -50 is the one from the brief; the rest are the values that slipped past
  // the old checks for different reasons.
  const bad = [
    ['negative', -50],
    ['zero', 0],
    ['a non-numeric string', 'abc'],
    ['an empty object', {}],
    ['Infinity', Infinity],
    ['NaN', NaN],
    ['a negative string', '-50'],
  ];

  describe('on update', () => {
    test.each(bad)('refuses %s', async (_label, value) => {
      await expect(
        ParkingSpot.update(1, 7, { price_per_hour: value }, 'SPOTTER')
      ).rejects.toThrow(/price_per_hour must be a positive number/);

      // Nothing is written at all — not the price, not the rest of the body.
      expect(prisma.parking_spots.update).not.toHaveBeenCalled();
    });

    test('accepts a valid price and rounds to paise', async () => {
      await ParkingSpot.update(1, 7, { price_per_hour: '40.555' }, 'SPOTTER');
      expect(written(prisma.parking_spots.update).price_per_hour).toBe(40.56);
    });

    test('leaves the price alone when it is not in the body', async () => {
      await ParkingSpot.update(1, 7, { title: 'Renamed' }, 'SPOTTER');
      expect(written(prisma.parking_spots.update).price_per_hour).toBeUndefined();
    });
  });

  describe('on create', () => {
    test.each(bad)('refuses %s', async (_label, value) => {
      await expect(
        ParkingSpot.create({ ...NEW_SPOT, price_per_hour: value }, 'SPOTTER')
      ).rejects.toThrow(/price_per_hour must be a positive number/);
      expect(prisma.parking_spots.create).not.toHaveBeenCalled();
    });

    test('a missing price is refused too — a spot must cost something', async () => {
      const { price_per_hour, ...noPrice } = NEW_SPOT;
      await expect(ParkingSpot.create(noPrice, 'SPOTTER')).rejects.toThrow(
        /price_per_hour must be a positive number/
      );
    });

    test('accepts a valid price', async () => {
      await ParkingSpot.create({ ...NEW_SPOT, price_per_hour: 40 }, 'SPOTTER');
      expect(written(prisma.parking_spots.create).price_per_hour).toBe(40);
    });
  });

  test('the error carries a 400, so the controller answers the caller not "server error"', async () => {
    // A rejected field is the caller's fault. The controller used to turn this
    // into a blanket 500, which told them nothing to correct.
    await expect(
      ParkingSpot.update(1, 7, { price_per_hour: -50 }, 'SPOTTER')
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

/**
 * The model guard is worth nothing if the controller does not hand it the real
 * caller's role. These drive SpotController with prisma mocked, so the request
 * goes through the controller AND the model — which is what an owner actually
 * hits. Found by mutation: replacing `req.user.role` with a hardcoded 'ADMIN'
 * broke no test at all until these existed.
 */
describe('the controller passes the REAL caller role, not a literal', () => {
  const SpotController = require('../../src/controllers/spotController');

  const res = () => {
    const r = {};
    r.status = jest.fn().mockReturnValue(r);
    r.json = jest.fn().mockReturnValue(r);
    return r;
  };

  beforeEach(() => {
    // The spot exists and belongs to user 7, so the ownership check passes.
    prisma.parking_spots.findFirst.mockResolvedValue({ id: 1, spotter_id: 7, is_active: true });
  });

  test('a SPOTTER hitting PUT /spots/:id cannot set location_type', async () => {
    const r = res();
    await SpotController.updateSpot(
      { params: { id: '1' }, body: { location_type: 'rural' }, user: { id: 7, role: 'SPOTTER' } },
      r
    );

    expect(written(prisma.parking_spots.update).location_type).toBeUndefined();
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  test('an ADMIN hitting the same route can', async () => {
    await SpotController.updateSpot(
      { params: { id: '1' }, body: { location_type: 'rural' }, user: { id: 7, role: 'ADMIN' } },
      res()
    );

    expect(written(prisma.parking_spots.update).location_type).toBe('rural');
  });

  test('a bad price comes back as 400 with the reason, not 500', async () => {
    const r = res();
    await SpotController.updateSpot(
      { params: { id: '1' }, body: { price_per_hour: -50 }, user: { id: 7, role: 'SPOTTER' } },
      r
    );

    expect(r.status).toHaveBeenCalledWith(400);
    expect(r.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, message: expect.stringMatching(/positive number/) })
    );
    expect(prisma.parking_spots.update).not.toHaveBeenCalled();
  });

  test('somebody else\'s spot is still refused before any of this', async () => {
    prisma.parking_spots.findFirst.mockResolvedValue({ id: 1, spotter_id: 99, is_active: true });
    const r = res();

    await SpotController.updateSpot(
      { params: { id: '1' }, body: { location_type: 'rural' }, user: { id: 7, role: 'SPOTTER' } },
      r
    );

    expect(r.status).toHaveBeenCalledWith(403);
    expect(prisma.parking_spots.update).not.toHaveBeenCalled();
  });
});
