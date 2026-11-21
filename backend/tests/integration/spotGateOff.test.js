/**
 * THE GATE OFF, END TO END — the state that is about to be in production.
 *
 * Per-spot verification ships behind SPOT_VERIFICATION_GATE, default OFF,
 * because Railway deploys from main while the owner's upload screen needs an
 * app release. In the gap, an owner on the installed build would submit a
 * spot, watch it go invisible, and have nothing to fix it with.
 *
 * So the claim this file exists to prove is narrow and important: MERGING
 * CHANGES NOTHING. A new spot is in the finder, it is bookable, and no owner
 * is promised anything — exactly as on the commit before stage 1.
 *
 * And the second claim, which is what makes the flag useful rather than just
 * safe: the whole flow still WORKS. Submissions are recorded, the desk review
 * and the field check still decide, the queue still lists, both stages are
 * still required. Only the consequences are held back, so the feature can be
 * exercised before anybody is subject to it.
 *
 * The deliberate contrast with tests/integration/spotVerification.test.js,
 * which sets the gate ON and asserts the opposite of the first half of this.
 *
 *   npm run test:integration
 */
// Before anything requires the constants module, which is where it is read.
delete process.env.SPOT_VERIFICATION_GATE;

jest.mock('../../src/config/firebase', () => ({
  adminApp: {},
  auth: {
    verifyIdToken: jest.fn().mockImplementation((token) => {
      if (token && typeof token === 'string' && token.startsWith('mock-firebase-token-')) {
        const uid = token.replace('mock-firebase-token-', '');
        return Promise.resolve({ uid, email: `${uid}@gmail.com`, name: uid });
      }
      return Promise.reject(new Error('Not a mock Firebase token'));
    }),
  },
}));

jest.mock('cloudinary', () => {
  let n = 0;
  return {
    v2: {
      config: jest.fn(),
      url: (publicId) => `https://signed.test/${publicId}`,
      uploader: {
        upload_stream: (opts, cb) => ({
          end: () => cb(null, { public_id: `parkstop/spot-docs/gateoff-${++n}`, format: 'jpg' }),
        }),
        destroy: jest.fn().mockResolvedValue({ result: 'ok' }),
      },
    },
  };
});

jest.mock('../../src/services/geocoding', () => {
  const actual = jest.requireActual('../../src/services/geocoding');
  return { ...actual, geocodeAddress: jest.fn() };
});

process.env.CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'test-cloud';

const request = require('supertest');
const { app } = require('../../src/server');
const prisma = require('../../src/config/prisma');
const { geocodeAddress, PRECISION } = require('../../src/services/geocoding');
const { isSpotGateEnabled } = require('../../src/constants/spotVerification');

const OWNER = { uid: 'gateoffowner', email: 'gateoffowner@gmail.com', phone: '9876420001' };
const DRIVER = { uid: 'gateoffdriver', email: 'gateoffdriver@gmail.com', phone: '9876420002' };
const ADMIN = { uid: 'gateoffadmin', email: 'gateoffadmin@gmail.com', phone: '9876420003' };
const UNVERIFIED = { uid: 'gateoffunver', email: 'gateoffunver@gmail.com', phone: '9876420004' };

const token = (w) => `mock-firebase-token-${w.uid}`;
const auth = (w) => ({ Authorization: `Bearer ${token(w)}` });

/** Far from the other suites' fixtures, so their spots cannot leak in. */
const PIN = { latitude: 13.11022233, longitude: 77.71033344 };
const NEARBY = `/api/v1/spots/nearby?lat=${PIN.latitude}&lng=${PIN.longitude}&radius=2`;
const ADDRESS = '7 Gate Off Road, Yelahanka, Bengaluru 560064';

const ids = { spots: {} };

async function register(who, role) {
  await request(app).post('/api/v1/auth/register').send({
    email: who.email, name: who.uid, phone: who.phone, role, firebase_token: token(who),
  });
  return prisma.users.findFirst({ where: { firebase_uid: who.uid } });
}

async function makeSpot(ownerId, title, status = 'not_started') {
  const spot = await prisma.parking_spots.create({
    data: {
      spotter_id: ownerId,
      title,
      description: 'fixture',
      price_per_hour: 40,
      ...PIN,
      address: '1 Gate Off St',
      total_slots: 2, available_slots: 2, car_slots: 2, bike_slots: 0,
      location_type: 'urban', is_active: true, amenities: [],
      spot_verification_status: status,
      spot_verification: {
        create: { status, ...(status === 'grandfathered' ? { grandfathered_at: new Date() } : {}) },
      },
    },
  });
  ids.spots[title] = spot.id;
  return spot.id;
}

const titlesIn = (body) => (body.data || []).map((s) => s.title);
const recordFor = (id) => prisma.spot_verifications.findUnique({ where: { spot_id: id } });
const spotRow = (id) => prisma.parking_spots.findUnique({ where: { id } });
const mine = (who, id) => request(app).get(`/api/v1/spot-verification/${id}`).set(auth(who));

beforeAll(async () => {
  const owner = await register(OWNER, 'spotter');
  const driver = await register(DRIVER, 'finder');
  const admin = await register(ADMIN, 'spotter');
  const unverified = await register(UNVERIFIED, 'spotter');

  await prisma.users.updateMany({
    where: { id: { in: [owner.id, admin.id] } },
    data: { verification_status: 'approved' },
  });
  await prisma.users.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });

  ids.owner = owner.id;
  ids.driver = driver.id;
  ids.admin = admin.id;
  ids.unverified = unverified.id;

  await prisma.owner_verifications.createMany({
    data: [{ user_id: owner.id, status: 'approved', aadhaar_name: 'Rajesh Kumar' }],
    skipDuplicates: true,
  });

  geocodeAddress.mockResolvedValue({
    lat: String(PIN.latitude), lon: String(PIN.longitude),
    precision: PRECISION.STREET, uncertainty_m: 150, source: 'nominatim',
    display_name: 'Yelahanka, Bengaluru', bbox: null, place_rank: 26, kind: 'highway/residential',
  });
});

afterAll(async () => {
  const spotIds = Object.values(ids.spots);
  await prisma.bookings.deleteMany({ where: { spot_id: { in: spotIds } } });
  await prisma.saved_spots.deleteMany({ where: { spot_id: { in: spotIds } } });
  await prisma.spot_verifications.deleteMany({ where: { spot_id: { in: spotIds } } });
  await prisma.parking_spots.deleteMany({ where: { id: { in: spotIds } } });
  await prisma.owner_verifications.deleteMany({ where: { user_id: { in: [ids.owner] } } });
  await prisma.users.deleteMany({
    where: { email: { in: [OWNER.email, DRIVER.email, ADMIN.email, UNVERIFIED.email] } },
  });
  await prisma.$disconnect();
});

test('the gate really is off in this suite', () => {
  // If this fails, every assertion below is about the wrong world.
  expect(isSpotGateEnabled()).toBe(false);
});

// ───────────────── merging changes nothing for drivers ─────────────────

describe('a spot nobody has checked is in the finder anyway', () => {
  beforeAll(async () => {
    await makeSpot(ids.owner, 'gateoff-unchecked', 'not_started');
    await makeSpot(ids.owner, 'gateoff-rejected', 'rejected');
    await makeSpot(ids.owner, 'gateoff-grandfathered', 'grandfathered');
    await makeSpot(ids.owner, 'gateoff-approved', 'approved');
  });

  test('/spots/nearby returns ALL of them, whatever their status', async () => {
    const res = await request(app).get(NEARBY);
    const titles = titlesIn(res.body);

    expect(res.status).toBe(200);
    expect(titles).toContain('gateoff-unchecked');
    expect(titles).toContain('gateoff-approved');
    expect(titles).toContain('gateoff-grandfathered');
    // Even a rejected spot, because before stage 1 there was nothing to reject.
    expect(titles).toContain('gateoff-rejected');
  });

  test('a spot with a NULL status is visible too, not merely a widened list', async () => {
    // The reason the filter is ABSENT rather than widened: `= ANY(array)` is
    // false for NULL, so a row that missed the backfill would stay hidden and
    // "off" would not mean "no change".
    const id = await makeSpot(ids.owner, 'gateoff-null-status', 'not_started');
    await prisma.parking_spots.update({ where: { id }, data: { spot_verification_status: null } });

    const titles = titlesIn((await request(app).get(NEARBY)).body);
    expect(titles).toContain('gateoff-null-status');
  });

  test('an unchecked spot can be booked', async () => {
    const res = await request(app)
      .post('/api/v1/bookings')
      .set(auth(DRIVER))
      .send({
        spot_id: ids.spots['gateoff-unchecked'],
        start_time: new Date(Date.now() + 60_000).toISOString(),
        end_time: new Date(Date.now() + 3_660_000).toISOString(),
      });

    expect(res.status).toBe(201);
    await prisma.bookings.deleteMany({ where: { spot_id: ids.spots['gateoff-unchecked'] } });
  });

  test('a saved unchecked spot still comes back in the saved list', async () => {
    const id = ids.spots['gateoff-unchecked'];
    const saved = await request(app).post(`/api/v1/saved-spots/${id}/toggle`).set(auth(DRIVER));
    expect(saved.status).toBeLessThan(400);

    const res = await request(app).get('/api/v1/saved-spots').set(auth(DRIVER));

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('gateoff-unchecked');
    await prisma.saved_spots.deleteMany({ where: { spot_id: id } });
  });
});

describe('the owner is promised nothing, because nothing is being withheld', () => {
  test('an unchecked spot reads as live, with no countdown', async () => {
    const id = ids.spots['gateoff-unchecked'];

    const d = (await mine(OWNER, id)).body.data;

    expect(d.gate_enforced).toBe(false);
    expect(d.is_live).toBe(true);
    expect(d.promised_hours).toBeNull();
    expect(d.hours_left).toBeNull();
    expect(d.message).toMatch(/Live on ParkStop/);
  });

  test('even after submitting, it stays live and stays uncounted', async () => {
    const id = await makeSpot(ids.owner, 'gateoff-submitted');

    await request(app)
      .post(`/api/v1/spot-verification/${id}/document`)
      .set(auth(OWNER))
      .field('doc_type', 'khata_certificate')
      .field('address', ADDRESS)
      .field('relationship', 'owner')
      .attach('document', Buffer.from('gateoff-doc'), 'khata.jpg');
    expect((await request(app).post(`/api/v1/spot-verification/${id}/submit`).set(auth(OWNER))).status).toBe(200);

    const d = (await mine(OWNER, id)).body.data;
    expect(d.status).toBe('desk_pending');
    expect(d.is_live).toBe(true);
    expect(d.promised_hours).toBeNull();

    // And it is still in the finder while we look at it.
    expect(titlesIn((await request(app).get(NEARBY)).body)).toContain('gateoff-submitted');
  });
});

describe('the pin rule falls back to the one from before stage 1', () => {
  const move = (who, id) => request(app)
    .put(`/api/v1/spots/${id}`)
    .set(auth(who))
    .send({ latitude: PIN.latitude + 0.02, longitude: PIN.longitude + 0.02 });

  test('an APPROVED owner cannot move a spot, whatever its verification says', async () => {
    const id = await makeSpot(ids.owner, 'gateoff-pin-approved-owner', 'not_started');

    const res = await move(OWNER, id);

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/now that your account is verified/);
  });

  test('an UNVERIFIED owner can still move theirs', async () => {
    const id = await makeSpot(ids.unverified, 'gateoff-pin-unverified-owner', 'approved');

    const res = await move(UNVERIFIED, id);

    expect(res.status).toBe(200);
    const row = await spotRow(id);
    expect(Number(row.latitude)).toBeCloseTo(PIN.latitude + 0.02, 4);
  });
});

// ───────────── and the whole flow still works, so it can be tested ─────────────

describe('the feature is held back, not switched off', () => {
  test('a submission goes through both stages and records approved', async () => {
    const id = await makeSpot(ids.owner, 'gateoff-full-flow');

    await request(app)
      .post(`/api/v1/spot-verification/${id}/document`)
      .set(auth(OWNER))
      .field('doc_type', 'khata_certificate')
      .field('address', ADDRESS)
      .field('relationship', 'owner')
      .attach('document', Buffer.from('gateoff-full-flow-doc'), 'khata.jpg');
    await request(app).post(`/api/v1/spot-verification/${id}/submit`).set(auth(OWNER));

    const desk = await request(app)
      .post(`/api/v1/spot-verification/admin/${id}/desk`)
      .set(auth(ADMIN))
      .send({ decision: 'pass', name_on_document: 'Rajesh Kumar' });
    expect(desk.status).toBe(200);
    expect((await recordFor(id)).status).toBe('desk_approved');

    const field = await request(app)
      .post(`/api/v1/spot-verification/admin/${id}/field`)
      .set(auth(ADMIN))
      .send({ office: 'SRO Yelahanka', record_found: true, reference: 'SRO/YLK/2026/1' });
    expect(field.status).toBe(200);
    expect((await recordFor(id)).status).toBe('approved');
  });

  test('both stages are still required — a field check cannot skip the desk', async () => {
    const id = await makeSpot(ids.owner, 'gateoff-stage-order');
    await prisma.spot_verifications.update({
      where: { spot_id: id },
      data: { status: 'desk_pending', submitted_at: new Date(), doc_public_id: 'x', claimed_address: ADDRESS },
    });

    const res = await request(app)
      .post(`/api/v1/spot-verification/admin/${id}/field`)
      .set(auth(ADMIN))
      .send({ office: 'SRO Yelahanka', record_found: true, reference: 'SRO/YLK/2026/2' });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/desk review has to pass before/);
  });

  test('the desk checks still block a name that is not the same person', async () => {
    const id = await makeSpot(ids.owner, 'gateoff-name-block');
    await request(app)
      .post(`/api/v1/spot-verification/${id}/document`)
      .set(auth(OWNER))
      .field('doc_type', 'khata_certificate')
      .field('address', ADDRESS)
      .field('relationship', 'owner')
      .attach('document', Buffer.from('gateoff-name-block-doc'), 'khata.jpg');
    await request(app).post(`/api/v1/spot-verification/${id}/submit`).set(auth(OWNER));

    const res = await request(app)
      .post(`/api/v1/spot-verification/admin/${id}/desk`)
      .set(auth(ADMIN))
      .send({ decision: 'pass', name_on_document: 'Mohan Lal' });

    expect(res.status).toBe(409);
    expect(res.body.blockers.map((b) => b.code)).toContain('NAME_NO_MATCH');
  });

  test('the admin queue still lists what is waiting', async () => {
    const res = await request(app)
      .get('/api/v1/spot-verification/admin/queue')
      .set(auth(ADMIN));

    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeGreaterThan(0);
    // The wait is still measured — it is the admin's workload either way.
    expect(res.body.data.promised_hours).toBe(48);
  });

  test('a document already used for another address is still refused', async () => {
    const a = await makeSpot(ids.owner, 'gateoff-dupe-a');
    const b = await makeSpot(ids.owner, 'gateoff-dupe-b');
    const file = 'gateoff-one-khata';

    const up = (id, address) => request(app)
      .post(`/api/v1/spot-verification/${id}/document`)
      .set(auth(OWNER))
      .field('doc_type', 'khata_certificate')
      .field('address', address)
      .field('relationship', 'owner')
      .attach('document', Buffer.from(file), 'khata.jpg');

    expect((await up(a, ADDRESS)).status).toBe(200);
    const res = await up(b, '99 Somewhere Else, Hebbal, Bengaluru 560024');

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already being used for a different address/);
  });
});
