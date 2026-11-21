/**
 * The spot write routes reject junk at the door.
 *
 * PUT /spots/:id had NO body validators at all — only the id was checked — so
 * every field arrived at the model unexamined. That is how an owner came to be
 * able to set the commission rate and a negative price. The model validates the
 * money, capacity and coordinate fields too and remains the authority; this
 * covers the ROUTE layer, which the model tests cannot reach, and the two
 * guards that only mean something against a real database: the live-booking
 * floor under total_slots, and the pin freeze for a verified owner.
 *
 * Written as an integration test for that reason: mutation testing showed that
 * deleting the route validators broke nothing at all while the only coverage
 * was model-level, because nothing exercised the Express stack.
 *
 *   npm run test:integration
 */
jest.mock('../../src/config/firebase', () => ({
  adminApp: {},
  auth: {
    verifyIdToken: jest.fn().mockImplementation((token) => {
      if (token && typeof token === 'string' && token.startsWith('mock-firebase-token-')) {
        const uid = token.replace('mock-firebase-token-', '');
        return Promise.resolve({
          uid,
          email: `${uid}@gmail.com`,
          name: uid.charAt(0).toUpperCase() + uid.slice(1),
        });
      }
      return Promise.reject(new Error('Not a mock Firebase token'));
    }),
  },
}));

const request = require('supertest');
const { app } = require('../../src/server');
const prisma = require('../../src/config/prisma');

/**
 * Two owners, because the pin rule turns on verification_status.
 *
 * `plain` is deliberately NOT approved: the route-layer tests are about body
 * shape, and an unapproved owner keeps the pin freeze out of the way.
 */
const PLAIN = { uid: 'spotvalidation', email: 'spotvalidation@gmail.com', phone: '9876500011' };
const VERIFIED = { uid: 'spotverified', email: 'spotverified@gmail.com', phone: '9876500012' };
const tokenFor = (o) => `mock-firebase-token-${o.uid}`;

/** The pin, stored at the column's full Decimal(10,8) / Decimal(11,8) width. */
const PIN = { latitude: 12.97159812, longitude: 77.59456234 };

const ids = {};

async function makeOwner(owner, { approved }) {
  await request(app).post('/api/v1/auth/register').send({
    email: owner.email,
    name: owner.uid,
    phone: owner.phone,
    role: 'spotter',
    firebase_token: tokenFor(owner),
  });

  const user = await prisma.users.findFirst({ where: { firebase_uid: owner.uid } });
  if (approved) {
    await prisma.users.update({ where: { id: user.id }, data: { verification_status: 'approved' } });
  }

  const spot = await prisma.parking_spots.create({
    data: {
      spotter_id: user.id,
      title: 'Validation bay',
      description: 'desc',
      price_per_hour: 40,
      latitude: PIN.latitude,
      longitude: PIN.longitude,
      address: '1 Validation St',
      base_price: 5,
      total_slots: 2,
      available_slots: 2,
      car_slots: 2,
      bike_slots: 0,
      location_type: 'urban',
      is_active: true,
      amenities: [],
    },
  });

  return { userId: user.id, spotId: spot.id };
}

beforeAll(async () => {
  ids.plain = await makeOwner(PLAIN, { approved: false });
  ids.verified = await makeOwner(VERIFIED, { approved: true });
});

afterAll(async () => {
  const spotIds = [ids.plain?.spotId, ids.verified?.spotId].filter(Boolean);
  // bookings reference spots with onDelete: NoAction, so they go first.
  await prisma.bookings.deleteMany({ where: { spot_id: { in: spotIds } } });
  await prisma.parking_spots.deleteMany({ where: { id: { in: spotIds } } });
  await prisma.users.deleteMany({ where: { email: { in: [PLAIN.email, VERIFIED.email] } } });
  await prisma.$disconnect();
});

const put = (owner, spotId, body) =>
  request(app).put(`/api/v1/spots/${spotId}`).set('Authorization', `Bearer ${tokenFor(owner)}`).send(body);

const putPlain = (body) => put(PLAIN, ids.plain.spotId, body);
const spotRow = (spotId) => prisma.parking_spots.findUnique({ where: { id: spotId } });

describe('PUT /spots/:id rejects junk before it reaches the model', () => {
  const rejected = [
    ['total_slots over the cap', { total_slots: 100 }],
    ['total_slots as a fraction', { total_slots: 2.5 }],
    ['total_slots as text', { total_slots: 'lots' }],
    ['total_slots at zero', { total_slots: 0 }],
    // null, not absent. express-validator v7 skips undefined only, which is
    // what we want: the app computes total_slots as car_slots + bike_slots and
    // sends null when that arithmetic produced NaN.
    ['total_slots as null', { total_slots: null }],
    ['car_slots negative', { car_slots: -1 }],
    ['car_slots as text', { car_slots: 'two' }],
    ['bike_slots over the cap', { bike_slots: 51 }],
    ['price negative', { price_per_hour: -50 }],
    ['price as text', { price_per_hour: 'abc' }],
    ['latitude out of range', { latitude: 200, longitude: 77.59 }],
    ['longitude out of range', { latitude: 12.97, longitude: -500 }],
    ['title empty', { title: '' }],
    ['title blank', { title: '   ' }],
    ['amenities not a list', { amenities: 'lots' }],
    ['images not a list', { images: 'one.png' }],
  ];

  test.each(rejected)('400 for %s', async (_label, body) => {
    const res = await putPlain(body);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('a lone latitude is refused — half a coordinate is not a location', async () => {
    const res = await putPlain({ latitude: 28.61 });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/together/i);
    // At the door, as a named field: the model refuses this as well, so
    // without this the route's pairing check could be deleted unnoticed.
    expect(res.body.message).toBe('Validation failed');
    expect(res.body.errors.map((e) => e.field)).toContain('longitude');
    // And the pin is untouched, rather than half-written.
    const row = await spotRow(ids.plain.spotId);
    expect(Number(row.latitude)).toBeCloseTo(PIN.latitude, 6);
  });

  test('a lone longitude is refused too', async () => {
    const res = await putPlain({ longitude: 77.2 });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/together/i);
    expect(res.body.message).toBe('Validation failed');
  });

  /**
   * These two cover the ROUTE as a layer.
   *
   * The model refuses a 100-bay driveway as well, so a test that only checked
   * for a 400 would pass with every body validator on this route deleted —
   * which is what mutation testing found. The route's answer is distinguishable
   * from the model's: it names the field in an `errors` array, where the model
   * throws one message for the request. Asserting that shape is what makes the
   * validators load-bearing.
   */
  const fieldLevel = [
    ['total_slots', { total_slots: 100 }],
    ['price_per_hour', { price_per_hour: -50 }],
    ['latitude', { latitude: 200, longitude: 77.59 }],
    ['car_slots', { car_slots: -1 }],
    ['title', { title: '' }],
  ];

  test.each(fieldLevel)('the rejection of %s names that field, not the whole body', async (field, body) => {
    const res = await putPlain(body);

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Validation failed');
    expect(res.body.errors.map((e) => e.field)).toContain(field);
  });

  /**
   * And these are the fields the ROUTE alone protects: the model passes title,
   * description, address, amenities and images straight through to Prisma, so
   * nothing behind this door checks their shape. An unbounded description is a
   * free write of any size into the row every driver's spot card reads.
   */
  const routeOnly = [
    ['a description longer than 2000 characters', { description: 'x'.repeat(2001) }],
    ['an address longer than 300 characters', { address: 'x'.repeat(301) }],
    ['a title longer than 120 characters', { title: 'x'.repeat(121) }],
    ['more than 30 amenities', { amenities: Array(31).fill('ev') }],
    ['an amenity that is not text', { amenities: [{ ev: true }] }],
    ['more than 10 images', { images: Array(11).fill('a.png') }],
    ['location_type that is not text', { location_type: { rural: true } }],
  ];

  test.each(routeOnly)('400 for %s', async (_label, body) => {
    const res = await putPlain(body);

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Validation failed');
  });

  test('a valid partial update still works', async () => {
    const res = await putPlain({ title: 'Renamed bay', total_slots: 3 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const row = await spotRow(ids.plain.spotId);
    expect(row.title).toBe('Renamed bay');
    expect(row.total_slots).toBe(3);
  });

  test('a field outside the write path is ignored, not applied', async () => {
    // available_slots is derived from counted bookings, spotter_id is
    // ownership, and is_active belongs to the toggle routes. None of them is
    // part of an update, and sending them must not change anything.
    const before = await spotRow(ids.plain.spotId);

    const res = await putPlain({
      title: 'Still mine',
      available_slots: 99,
      spotter_id: 1,
      is_active: false,
      commission_rate: 0,
    });

    expect(res.status).toBe(200);
    const after = await spotRow(ids.plain.spotId);
    expect(after.available_slots).toBe(before.available_slots);
    expect(after.spotter_id).toBe(before.spotter_id);
    expect(after.is_active).toBe(true);
  });

  test('an unverified owner may still move the pin, and it is written', async () => {
    const res = await putPlain({ latitude: 12.975, longitude: 77.6 });

    expect(res.status).toBe(200);
    const row = await spotRow(ids.plain.spotId);
    expect(Number(row.latitude)).toBeCloseTo(12.975, 6);

    // Put it back for the tests that follow.
    await prisma.parking_spots.update({ where: { id: ids.plain.spotId }, data: PIN });
  });
});

describe('POST /spots rejects the same junk', () => {
  const body = (over) => ({
    title: 'A new bay',
    description: 'desc',
    price_per_hour: 40,
    latitude: 12.97,
    longitude: 77.59,
    address: '2 Validation St',
    total_slots: 2,
    car_slots: 2,
    bike_slots: 0,
    ...over,
  });

  const rejected = [
    ['total_slots over the cap', { total_slots: 100 }],
    ['car_slots as text', { car_slots: 'two' }],
    ['car_slots over total_slots', { total_slots: 2, car_slots: 5 }],
    ['no title', { title: '' }],
    ['latitude out of range', { latitude: 200 }],
    ['price of zero', { price_per_hour: 0 }],
  ];

  test.each(rejected)('400 for %s', async (_label, over) => {
    const res = await request(app)
      .post('/api/v1/spots')
      .set('Authorization', `Bearer ${tokenFor(PLAIN)}`)
      .send(body(over));

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  // Same reasoning as the update route: the model bounds these too, so a test
  // that only looked for a 400 would pass with the create route's validators
  // deleted. The route names the field.
  const fieldLevel = [
    ['total_slots', { total_slots: 100 }],
    ['car_slots', { car_slots: 'two' }],
    ['bike_slots', { bike_slots: 51 }],
    ['latitude', { latitude: 200 }],
    ['price_per_hour', { price_per_hour: 0 }],
  ];

  test.each(fieldLevel)('the rejection of %s names that field', async (field, over) => {
    const res = await request(app)
      .post('/api/v1/spots')
      .set('Authorization', `Bearer ${tokenFor(PLAIN)}`)
      .send(body(over));

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Validation failed');
    expect(res.body.errors.map((e) => e.field)).toContain(field);
  });

  test('a good create still works', async () => {
    const res = await request(app)
      .post('/api/v1/spots')
      .set('Authorization', `Bearer ${tokenFor(PLAIN)}`)
      .send(body({ total_slots: 3, car_slots: 2, bike_slots: 1 }));

    expect(res.status).toBe(201);
    expect(res.body.data.total_slots).toBe(3);
    expect(res.body.data.available_slots).toBe(3);

    await prisma.parking_spots.deleteMany({ where: { id: res.body.data.id } });
  });
});

describe('capacity cannot be cut below the cars already parked', () => {
  const spotId = () => ids.plain.spotId;

  beforeEach(async () => {
    await prisma.parking_spots.update({
      where: { id: spotId() },
      data: { total_slots: 3, available_slots: 3, car_slots: 3, bike_slots: 0 },
    });
    await prisma.bookings.deleteMany({ where: { spot_id: spotId() } });
  });

  const park = (n) =>
    prisma.bookings.createMany({
      data: Array.from({ length: n }, () => ({
        spot_id: spotId(),
        user_id: ids.plain.userId,
        start_time: new Date(),
        end_time: new Date(Date.now() + 3600_000),
        status: 'active',
        total_price: 40,
      })),
    });

  test('two cars parked: dropping to one bay is refused', async () => {
    await park(2);

    const res = await putPlain({ total_slots: 1, car_slots: 1 });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/2 booking\(s\) are using this spot right now/);
    expect((await spotRow(spotId())).total_slots).toBe(3);
  });

  test('dropping to exactly the number parked is allowed', async () => {
    await park(2);

    const res = await putPlain({ total_slots: 2, car_slots: 2 });

    expect(res.status).toBe(200);
    expect((await spotRow(spotId())).total_slots).toBe(2);
  });

  test('a finished booking does not hold a bay', async () => {
    await park(2);
    await prisma.bookings.updateMany({ where: { spot_id: spotId() }, data: { status: 'completed' } });

    const res = await putPlain({ total_slots: 1, car_slots: 1 });

    expect(res.status).toBe(200);
    expect((await spotRow(spotId())).total_slots).toBe(1);
  });
});

/**
 * The pin freeze, end to end — and the flow it must NOT break.
 *
 * The owner's edit screen prefills latitude and longitude from the dashboard
 * and posts them back with every save, so the coordinates make a round trip
 * through Decimal(10,8) -> JSON -> parseFloat on every title change. If that
 * counted as moving the pin, a verified owner could not edit their own spot at
 * all.
 */
describe('a verified owner cannot move their spot', () => {
  const spotId = () => ids.verified.spotId;
  const putVerified = (body) => put(VERIFIED, spotId(), body);

  test('saving the edit form unchanged is not a move', async () => {
    // Exactly what the app does: read the spot from the dashboard, then send
    // parseFloat() of the values it was given.
    const dash = await request(app)
      .get('/api/v1/spots/dashboard')
      .set('Authorization', `Bearer ${tokenFor(VERIFIED)}`);
    expect(dash.status).toBe(200);

    const mine = dash.body.data.inventory.find((s) => s.id === spotId());
    expect(mine).toBeDefined();

    const res = await putVerified({
      title: 'Edited while verified',
      price_per_hour: 45,
      latitude: parseFloat(String(mine.latitude)),
      longitude: parseFloat(String(mine.longitude)),
      total_slots: 2,
      car_slots: 2,
      bike_slots: 0,
    });

    expect(res.status).toBe(200);
    const row = await spotRow(spotId());
    expect(row.title).toBe('Edited while verified');
    expect(Number(row.price_per_hour)).toBe(45);
    // The pin is still exactly where it was, to the last stored digit.
    expect(row.latitude.toString()).toBe(PIN.latitude.toFixed(8));
    expect(row.longitude.toString()).toBe(PIN.longitude.toFixed(8));
  });

  test('moving it across the city is refused', async () => {
    const res = await putVerified({ latitude: 28.61, longitude: 77.2 });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cannot be moved now that your account is verified/);
    expect(res.body.message).toMatch(/new spot|support/i);

    const row = await spotRow(spotId());
    expect(row.latitude.toString()).toBe(PIN.latitude.toFixed(8));
  });

  test('a nudge of a few metres is tolerated, and changes nothing', async () => {
    // ~2 m: the kind of difference a float round trip or a re-geocode makes.
    const res = await putVerified({
      latitude: PIN.latitude + 0.00002,
      longitude: PIN.longitude,
    });

    expect(res.status).toBe(200);
    const row = await spotRow(spotId());
    expect(row.latitude.toString()).toBe(PIN.latitude.toFixed(8));
  });

  test('a move of 100 metres is still a move', async () => {
    const res = await putVerified({
      latitude: PIN.latitude + 0.001,
      longitude: PIN.longitude,
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cannot be moved/);
  });
});
