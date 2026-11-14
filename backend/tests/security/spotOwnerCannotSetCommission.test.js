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

/**
 * Capacity is not a free text field.
 *
 * total_slots feeds three things, none of them cosmetic:
 *
 *   - advertised availability. withLiveAvailability is `total_slots - counted
 *     bookings` and ignores the stored counter, so total_slots: 100 advertises
 *     100 free bays on a driveway that holds one.
 *   - the slot picker. SpotController.getSlotStatus generates one named slot
 *     per total_slots when slot_names is empty — 100 invents "Slot A1" to
 *     "Slot J10" for a driver to choose from.
 *   - the surge multiplier. demandMultiplierFor is `active / total_slots`, so
 *     LOWERING it raises what the next driver pays: one active booking against
 *     total_slots: 1 is a ratio of 1.0, which is 2.0x.
 *
 * car_slots and bike_slots are live per-type counters that the booking flow
 * decrements and increments (Booking.js), and Booking.create reads them when
 * deciding whether to admit a car.
 */
describe('slot counts are bounded', () => {
  /** A two-bay spot with one car bay free, owned by an approved owner. */
  const storedSpot = {
    latitude: 12.97, longitude: 77.59,
    total_slots: 2, car_slots: 1, bike_slots: 0,
    users: { verification_status: 'approved' },
  };

  beforeEach(() => {
    prisma.bookings.count.mockResolvedValue(0);
    prisma.parking_spots.findUnique.mockResolvedValue({ ...storedSpot });
  });

  const bad = [
    ['zero', 0], ['negative', -1], ['a fraction', 2.5], ['over the cap', 51],
    ['a string', 'lots'], ['NaN', NaN], ['Infinity', Infinity],
    // Each of these is Number()-coerced to a valid-looking count — Number('')
    // and Number(null) are 0, Number(true) is 1 — which is exactly why this
    // guard does not use Number().
    ['null', null], ['empty', ''], ['blank', '   '], ['true', true], ['an array', []],
  ];

  test.each(bad)('update refuses total_slots that is %s', async (_l, v) => {
    await expect(ParkingSpot.update(1, 7, { total_slots: v }, 'SPOTTER'))
      .rejects.toThrow(/total_slots must be a whole number between 1 and 50/);
    expect(prisma.parking_spots.update).not.toHaveBeenCalled();
  });

  test('a bad count is refused before the spot is even read', async () => {
    // The guard is pure arithmetic on the request, so it costs no query.
    await expect(ParkingSpot.update(1, 7, { total_slots: 100 }, 'SPOTTER')).rejects.toThrow();
    expect(prisma.parking_spots.findUnique).not.toHaveBeenCalled();
    expect(prisma.bookings.count).not.toHaveBeenCalled();
  });

  test('update refuses 100 — the driveway-with-100-bays case', async () => {
    await expect(ParkingSpot.update(1, 7, { total_slots: 100 }, 'SPOTTER'))
      .rejects.toThrow(/between 1 and 50/);
  });

  test('the cap itself is allowed, one past it is not', async () => {
    await ParkingSpot.update(1, 7, { total_slots: 50, car_slots: 50 }, 'SPOTTER');
    expect(written(prisma.parking_spots.update).total_slots).toBe(50);

    await expect(ParkingSpot.update(1, 7, { total_slots: 51 }, 'SPOTTER'))
      .rejects.toThrow(/between 1 and 50/);
  });

  test('update accepts a sane total', async () => {
    await ParkingSpot.update(1, 7, { total_slots: 3 }, 'SPOTTER');
    expect(written(prisma.parking_spots.update).total_slots).toBe(3);
  });

  test('a numeric string from a form is accepted, as a number', async () => {
    await ParkingSpot.update(1, 7, { total_slots: '3' }, 'SPOTTER');
    expect(written(prisma.parking_spots.update).total_slots).toBe(3);
  });

  test('car_slots and bike_slots are bounded too, and may be 0', async () => {
    await expect(ParkingSpot.update(1, 7, { car_slots: -1 }, 'SPOTTER'))
      .rejects.toThrow(/car_slots must be a whole number between 0 and 50/);
    await expect(ParkingSpot.update(1, 7, { bike_slots: 51 }, 'SPOTTER'))
      .rejects.toThrow(/bike_slots must be a whole number between 0 and 50/);
    expect(prisma.parking_spots.update).not.toHaveBeenCalled();

    await ParkingSpot.update(1, 7, { car_slots: 0 }, 'SPOTTER');
    expect(written(prisma.parking_spots.update).car_slots).toBe(0);
  });

  test('an empty car_slots is refused rather than read as zero', async () => {
    // Number('') is 0 and 0 is a legal car_slots, so a blank form field would
    // otherwise sail through and zero a live counter.
    await expect(ParkingSpot.update(1, 7, { car_slots: '' }, 'SPOTTER'))
      .rejects.toThrow(/car_slots must be a whole number between 0 and 50/);
  });

  test('a per-type counter cannot exceed total_slots', async () => {
    // Stored total is 2, so claiming 5 car bays is nonsense.
    await expect(ParkingSpot.update(1, 7, { car_slots: 5 }, 'SPOTTER'))
      .rejects.toThrow(/car_slots \(5\) cannot exceed total_slots \(2\)/);
    expect(prisma.parking_spots.update).not.toHaveBeenCalled();
  });

  test('raising both together works', async () => {
    await ParkingSpot.update(1, 7, { total_slots: 6, car_slots: 6 }, 'SPOTTER');
    const d = written(prisma.parking_spots.update);
    expect(d.total_slots).toBe(6);
    expect(d.car_slots).toBe(6);
  });

  test('lowering total_slots alone cannot strand a bigger car_slots', async () => {
    // The same lie by another route: send only total_slots and the spot keeps
    // the car bays it had. The check is against the row as it will END UP.
    prisma.parking_spots.findUnique.mockResolvedValue({ ...storedSpot, total_slots: 5, car_slots: 5 });

    await expect(ParkingSpot.update(1, 7, { total_slots: 1 }, 'SPOTTER'))
      .rejects.toThrow(/car_slots \(5\) cannot exceed total_slots \(1\)/);
    expect(prisma.parking_spots.update).not.toHaveBeenCalled();
  });

  test('bike_slots is checked against the stored total the same way', async () => {
    prisma.parking_spots.findUnique.mockResolvedValue({ ...storedSpot, total_slots: 4, car_slots: 0, bike_slots: 4 });

    await expect(ParkingSpot.update(1, 7, { total_slots: 2 }, 'SPOTTER'))
      .rejects.toThrow(/bike_slots \(4\) cannot exceed total_slots \(2\)/);
  });

  test('an already-inconsistent row is still editable when capacity is untouched', async () => {
    // car_slots > total_slots was writable until this change, so such rows
    // exist. Refusing a rename over a state the owner cannot see and did not
    // cause would lock them out of their own listing.
    prisma.parking_spots.findUnique.mockResolvedValue({ ...storedSpot, total_slots: 2, car_slots: 9 });

    await ParkingSpot.update(1, 7, { title: 'Renamed' }, 'SPOTTER');
    expect(written(prisma.parking_spots.update).title).toBe('Renamed');
  });

  test('a legacy row with total_slots NULL has nothing to compare against', async () => {
    prisma.parking_spots.findUnique.mockResolvedValue({ ...storedSpot, total_slots: null });

    await ParkingSpot.update(1, 7, { car_slots: 3 }, 'SPOTTER');
    expect(written(prisma.parking_spots.update).car_slots).toBe(3);
  });

  test('capacity cannot drop below the cars already parked', async () => {
    // Three live bookings; dropping to 1 would make the spot read as full and
    // vanish while three drivers are mid-booking, and push the surge ratio
    // over 1.0, which is 2.0x for whoever books next.
    // car_slots is 1 here so the cross-field rule above cannot fire first and
    // mask which guard is being tested.
    prisma.bookings.count.mockResolvedValue(3);

    await expect(ParkingSpot.update(1, 7, { total_slots: 1 }, 'SPOTTER'))
      .rejects.toThrow(/3 booking\(s\) are using this spot right now/);
    expect(prisma.parking_spots.update).not.toHaveBeenCalled();
  });

  test('the live count is the occupying statuses, not every booking', async () => {
    prisma.bookings.count.mockResolvedValue(0);
    await ParkingSpot.update(1, 7, { total_slots: 1, car_slots: 1 }, 'SPOTTER');

    const where = prisma.bookings.count.mock.calls[0][0].where;
    expect(where.spot_id).toBe(1);
    expect(where.status.in).toEqual(expect.arrayContaining(['reserved', 'active', 'checkout_pending']));
  });

  test('dropping to exactly the number parked is allowed', async () => {
    prisma.bookings.count.mockResolvedValue(3);
    await ParkingSpot.update(1, 7, { total_slots: 3 }, 'SPOTTER');
    expect(written(prisma.parking_spots.update).total_slots).toBe(3);
  });

  test('raising capacity is never blocked by live bookings', async () => {
    prisma.bookings.count.mockResolvedValue(2);
    await ParkingSpot.update(1, 7, { total_slots: 4 }, 'SPOTTER');
    expect(written(prisma.parking_spots.update).total_slots).toBe(4);
  });

  test('an ADMIN is bounded as well — this is not a permissions rule', async () => {
    await expect(ParkingSpot.update(1, 7, { total_slots: 100 }, 'ADMIN'))
      .rejects.toThrow(/between 1 and 50/);
    await expect(ParkingSpot.update(1, 7, { car_slots: 5 }, 'ADMIN'))
      .rejects.toThrow(/cannot exceed total_slots/);
  });

  test('an update that touches no capacity field reads no booking count', async () => {
    await ParkingSpot.update(1, 7, { title: 'Renamed' }, 'SPOTTER');
    expect(prisma.bookings.count).not.toHaveBeenCalled();
  });

  test('create is bounded on the same fields', async () => {
    await expect(ParkingSpot.create({ ...NEW_SPOT, total_slots: 100 }, 'SPOTTER'))
      .rejects.toThrow(/total_slots must be a whole number between 1 and 50/);
    await expect(ParkingSpot.create({ ...NEW_SPOT, total_slots: 0 }, 'SPOTTER'))
      .rejects.toThrow(/total_slots must be a whole number between 1 and 50/);
    await expect(ParkingSpot.create({ ...NEW_SPOT, total_slots: 2, car_slots: 5 }, 'SPOTTER'))
      .rejects.toThrow(/car_slots \(5\) cannot exceed total_slots \(2\)/);
    expect(prisma.parking_spots.create).not.toHaveBeenCalled();
  });

  test('create writes available_slots equal to the validated total', async () => {
    await ParkingSpot.create({ ...NEW_SPOT, total_slots: '4', car_slots: 4 }, 'SPOTTER');
    const d = written(prisma.parking_spots.create);
    expect(d.total_slots).toBe(4);
    expect(d.available_slots).toBe(4);
  });
});

/**
 * A coordinate is either a place or a 400 — never silently dropped.
 */
describe('coordinates have to be coordinates', () => {
  beforeEach(() => {
    prisma.bookings.count.mockResolvedValue(0);
    prisma.parking_spots.findUnique.mockResolvedValue({
      latitude: 12.97, longitude: 77.59, total_slots: 2, car_slots: 1, bike_slots: 0,
      users: { verification_status: null },
    });
  });

  test('a lone latitude is refused, not ignored', async () => {
    // It used to need BOTH to be usable, so this wrote nothing and answered
    // 200: the owner is told the pin moved, and drivers keep arriving at the
    // old place.
    await expect(ParkingSpot.update(1, 7, { latitude: 28.61 }, 'SPOTTER'))
      .rejects.toThrow(/latitude and longitude must be sent together/);
    expect(prisma.parking_spots.update).not.toHaveBeenCalled();
    expect(prisma.parking_spots.findUnique).not.toHaveBeenCalled();
  });

  test('a lone longitude is refused too', async () => {
    await expect(ParkingSpot.update(1, 7, { longitude: 77.2 }, 'SPOTTER'))
      .rejects.toThrow(/latitude and longitude must be sent together/);
  });

  test('neither is still "leave the pin alone"', async () => {
    await ParkingSpot.update(1, 7, { title: 'Renamed' }, 'SPOTTER');
    const d = written(prisma.parking_spots.update);
    expect(d.latitude).toBeUndefined();
    expect(d.longitude).toBeUndefined();
  });

  const junk = [
    ['text', 'abc', 'abc'],
    ['out of range latitude', 200, 77.59],
    ['out of range longitude', 12.97, -500],
    ['booleans', true, true],
  ];

  test.each(junk)('update refuses %s', async (_l, latitude, longitude) => {
    await expect(ParkingSpot.update(1, 7, { latitude, longitude }, 'SPOTTER'))
      .rejects.toThrow(/must be a number between/);
    expect(prisma.parking_spots.update).not.toHaveBeenCalled();
  });

  test.each(junk)('create refuses %s', async (_l, latitude, longitude) => {
    await expect(ParkingSpot.create({ ...NEW_SPOT, latitude, longitude }, 'SPOTTER'))
      .rejects.toThrow(/must be a number between/);
    expect(prisma.parking_spots.create).not.toHaveBeenCalled();
  });

  test('create refuses a spot with no pin at all', async () => {
    // A spot with no coordinates can never appear in the finder: it is
    // filtered on a bounding box. parseFloat(undefined) wrote NaN and Prisma
    // turned that into a 500.
    const { latitude, longitude, ...noPin } = NEW_SPOT;
    await expect(ParkingSpot.create(noPin, 'SPOTTER'))
      .rejects.toThrow(/latitude must be a number between -90 and 90/);
  });

  test('create stores a form string as a number', async () => {
    await ParkingSpot.create({ ...NEW_SPOT, latitude: '12.97', longitude: '77.59' }, 'SPOTTER');
    const d = written(prisma.parking_spots.create);
    expect(d.latitude).toBe(12.97);
    expect(d.longitude).toBe(77.59);
  });

  test('the edges of the range are valid places', async () => {
    await ParkingSpot.create({ ...NEW_SPOT, latitude: -90, longitude: 180 }, 'SPOTTER');
    expect(written(prisma.parking_spots.create).latitude).toBe(-90);
  });
});

/**
 * Moving the pin of a live spot.
 *
 * Owner verification approves a PERSON, not a place — nothing re-checks the
 * location afterwards. So once an owner is approved, their spots are visible
 * to drivers (findNearby filters on verification_status = 'approved') and the
 * pin is fixed: a different place is a different listing.
 *
 * The alternative — allow the move and reset verification — is not available
 * here: verification_status is a column on USERS, so resetting it would hide
 * every other spot the owner lists and send them back through KYC over a
 * 20-metre correction.
 */
describe('a verified owner cannot move a spot', () => {
  const atPin = (verification_status, rest = {}) => {
    prisma.parking_spots.findUnique.mockResolvedValue({
      latitude: 12.97, longitude: 77.59, total_slots: 2, car_slots: 1, bike_slots: 0,
      users: { verification_status },
      ...rest,
    });
  };

  beforeEach(() => { prisma.bookings.count.mockResolvedValue(0); });

  test('an approved owner moving the pin is refused', async () => {
    atPin('approved');

    await expect(
      ParkingSpot.update(1, 7, { latitude: 28.61, longitude: 77.20 }, 'SPOTTER')
    ).rejects.toThrow(/cannot be moved now that your account is verified/);
    expect(prisma.parking_spots.update).not.toHaveBeenCalled();
  });

  test('the refusal says what the owner can do instead', async () => {
    atPin('approved');

    await expect(
      ParkingSpot.update(1, 7, { latitude: 28.61, longitude: 77.20 }, 'SPOTTER')
    ).rejects.toThrow(/List the new location as a new spot, or contact ParkStop support/);
  });

  test('an approved owner can still edit everything else', async () => {
    // The whole point of the tolerance: the app sends the coordinates back
    // unchanged with every save, and that must not be read as a move.
    atPin('approved');

    await ParkingSpot.update(1, 7, { title: 'Renamed', latitude: 12.97, longitude: 77.59 }, 'SPOTTER');

    const d = written(prisma.parking_spots.update);
    expect(d.title).toBe('Renamed');
    // The column is not rewritten at all when nothing actually moved.
    expect(d.latitude).toBeUndefined();
  });

  test('a shift under the tolerance is not a move', async () => {
    atPin('approved');
    // ~2 metres: float round-trip territory, not a relocation.
    await ParkingSpot.update(1, 7, { latitude: 12.97002, longitude: 77.59 }, 'SPOTTER');
    expect(written(prisma.parking_spots.update).latitude).toBeUndefined();
  });

  test('a shift just past the tolerance IS a move', async () => {
    atPin('approved');
    // ~17 metres north. The guard is a tolerance, not a loophole to walk a
    // spot across the city ten metres at a time... which it still is, slowly;
    // see the PR notes.
    await expect(
      ParkingSpot.update(1, 7, { latitude: 12.97015, longitude: 77.59 }, 'SPOTTER')
    ).rejects.toThrow(/cannot be moved/);
  });

  test('an UNVERIFIED owner can still move it — nothing is live yet', async () => {
    atPin(null);

    await ParkingSpot.update(1, 7, { latitude: 28.61, longitude: 77.20 }, 'SPOTTER');

    expect(written(prisma.parking_spots.update).latitude).toBe(28.61);
  });

  test('a pending owner can still move it', async () => {
    atPin('pending');
    await ParkingSpot.update(1, 7, { latitude: 28.61, longitude: 77.20 }, 'SPOTTER');
    expect(written(prisma.parking_spots.update).latitude).toBe(28.61);
  });

  test('an ADMIN can move a verified spot', async () => {
    atPin('approved');

    await ParkingSpot.update(1, 7, { latitude: 28.61, longitude: 77.20 }, 'ADMIN');

    expect(written(prisma.parking_spots.update).latitude).toBe(28.61);
  });

  test('setting a pin for the first time is a fix, not a move', async () => {
    // A spot with no coordinates is invisible in the finder — it cannot pass
    // the bounding box — so refusing this would strand the listing for good.
    atPin('approved', { latitude: null, longitude: null });

    await ParkingSpot.update(1, 7, { latitude: 28.61, longitude: 77.20 }, 'SPOTTER');

    expect(written(prisma.parking_spots.update).latitude).toBe(28.61);
  });

  test('the move is judged against the stored pin, not the request', async () => {
    atPin('approved');
    await ParkingSpot.update(1, 7, { latitude: 12.97, longitude: 77.59 }, 'SPOTTER');
    expect(prisma.parking_spots.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1 } })
    );
  });
});
