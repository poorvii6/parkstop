/**
 * Per-spot verification, end to end: the gate, the clock and the queue.
 *
 * Owner verification approves a PERSON. Every spot here belongs to an owner
 * who is already approved — so anything hidden below is hidden because of the
 * SPOT's own address verification, which is the whole point of the feature.
 *
 * The test this file exists for is "a grandfathered spot stays visible": six
 * spots were live in the finder when this shipped, and they must not drop off
 * the map as a reward for their owners doing what we asked.
 *
 *   npm run test:integration
 */
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

// The document never leaves the test. upload_stream hands back a public_id the
// way Cloudinary would; nothing is sent anywhere.
jest.mock('cloudinary', () => {
  let n = 0;
  return {
    v2: {
      config: jest.fn(),
      url: (publicId) => `https://signed.test/${publicId}`,
      uploader: {
        upload_stream: (opts, cb) => ({
          end: () => cb(null, { public_id: `parkstop/spot-docs/mock-${++n}` }),
        }),
        destroy: jest.fn().mockResolvedValue({ result: 'ok' }),
      },
    },
  };
});

/**
 * The geocoder is mocked: these tests must not depend on Nominatim being up,
 * and Nominatim's usage policy is one request a second. What it ACTUALLY does
 * with Indian addresses is recorded in tests/unit/geocoding.test.js, from live
 * responses. Here each test says what came back and checks what we did about it.
 */
jest.mock('../../src/services/geocoding', () => {
  const actual = jest.requireActual('../../src/services/geocoding');
  return { ...actual, geocodeAddress: jest.fn() };
});

process.env.CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'test-cloud';

const request = require('supertest');
const { app } = require('../../src/server');
const prisma = require('../../src/config/prisma');

const OWNER = { uid: 'spotvowner', email: 'spotvowner@gmail.com', phone: '9876400001' };
const OTHER = { uid: 'spotvother', email: 'spotvother@gmail.com', phone: '9876400002' };
const DRIVER = { uid: 'spotvdriver', email: 'spotvdriver@gmail.com', phone: '9876400003' };
const ADMIN = { uid: 'spotvadmin', email: 'spotvadmin@gmail.com', phone: '9876400004' };
const token = (who) => `mock-firebase-token-${who.uid}`;
const auth = (who) => ({ Authorization: `Bearer ${token(who)}` });

/** All fixtures sit on the same pin, so distance never decides a result. */
const PIN = { latitude: 12.95011122, longitude: 77.55022233 };
const NEARBY = `/api/v1/spots/nearby?lat=${PIN.latitude}&lng=${PIN.longitude}&radius=2`;

const ids = { spots: {} };

async function register(who, role) {
  await request(app).post('/api/v1/auth/register').send({
    email: who.email, name: who.uid, phone: who.phone, role, firebase_token: token(who),
  });
  return prisma.users.findFirst({ where: { firebase_uid: who.uid } });
}

async function makeSpot(ownerId, title, status, extra = {}) {
  const spot = await prisma.parking_spots.create({
    data: {
      spotter_id: ownerId,
      title,
      description: 'fixture',
      price_per_hour: 40,
      ...PIN,
      address: '1 Verification St',
      total_slots: 2, available_slots: 2, car_slots: 2, bike_slots: 0,
      location_type: 'urban', is_active: true, amenities: [],
      spot_verification_status: status,
      spot_verification: {
        create: {
          status,
          ...(status === 'grandfathered' ? { grandfathered_at: new Date() } : {}),
        },
      },
      ...extra,
    },
  });
  return spot.id;
}

beforeAll(async () => {
  const owner = await register(OWNER, 'spotter');
  const other = await register(OTHER, 'spotter');
  const driver = await register(DRIVER, 'finder');
  const admin = await register(ADMIN, 'spotter');

  // Every owner here is APPROVED as a person. Anything hidden is hidden
  // because of the spot's own address check.
  await prisma.users.updateMany({
    where: { id: { in: [owner.id, other.id] } },
    data: { verification_status: 'approved' },
  });
  await prisma.users.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });

  ids.owner = owner.id;
  ids.other = other.id;
  ids.driver = driver.id;

  ids.spots.approved = await makeSpot(owner.id, 'Verified bay', 'approved');
  ids.spots.unverified = await makeSpot(owner.id, 'Unchecked bay', 'not_started');
  ids.spots.grandfathered = await makeSpot(owner.id, 'Grandfathered bay', 'grandfathered');
  // A second one that is never submitted, so the chasing backlog has something
  // in it after the first has moved on to the queue.
  ids.spots.grandfatheredUntouched = await makeSpot(owner.id, 'Grandfathered untouched bay', 'grandfathered');
  ids.spots.rejected = await makeSpot(owner.id, 'Rejected bay', 'rejected');
  ids.spots.foreign = await makeSpot(other.id, 'Someone else bay', 'not_started');
});

afterAll(async () => {
  const emails = [OWNER.email, OTHER.email, DRIVER.email, ADMIN.email];
  const spotIds = Object.values(ids.spots);
  await prisma.bookings.deleteMany({ where: { spot_id: { in: spotIds } } });
  await prisma.saved_spots.deleteMany({ where: { spot_id: { in: spotIds } } });
  await prisma.spot_verifications.deleteMany({ where: { spot_id: { in: spotIds } } });
  await prisma.parking_spots.deleteMany({ where: { id: { in: spotIds } } });
  await prisma.users.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});

const titlesIn = (body) => (body.data || []).map((s) => s.title);
const recordFor = (spotId) => prisma.spot_verifications.findUnique({ where: { spot_id: spotId } });
const spotRow = (spotId) => prisma.parking_spots.findUnique({ where: { id: spotId } });

// ───────────────────────────── the gate ─────────────────────────────

describe('a spot nobody has checked is not in the finder', () => {
  test('/spots/nearby returns only the verified and the grandfathered', async () => {
    const res = await request(app).get(NEARBY);

    expect(res.status).toBe(200);
    const titles = titlesIn(res.body);
    expect(titles).toContain('Verified bay');
    expect(titles).toContain('Grandfathered bay');
    expect(titles).not.toContain('Unchecked bay');
    expect(titles).not.toContain('Rejected bay');
    expect(titles).not.toContain('Someone else bay');
  });

  test('the "nearest alternatives" fallback applies it too', async () => {
    // Searching from ~5 km away: nothing is inside the 2 km radius, so the
    // finder falls back to findAbsoluteNearest. A fallback suggestion is still
    // a spot we are sending someone to, and that path had to be gated
    // separately — mutation testing caught it being the only one left open.
    const far = `/api/v1/spots/nearby?lat=${PIN.latitude + 0.045}&lng=${PIN.longitude}&radius=2`;

    const res = await request(app).get(far);

    expect(res.status).toBe(200);
    // Proof the fallback actually ran, rather than the ordinary search.
    expect(res.body.message).toMatch(/No spots within 2 km/);

    const titles = titlesIn(res.body);
    expect(titles).toContain('Verified bay');
    expect(titles).not.toContain('Unchecked bay');
    expect(titles).not.toContain('Rejected bay');
  });

  test('/spots (everything available) applies the same rule', async () => {
    const res = await request(app).get('/api/v1/spots');

    const titles = titlesIn(res.body);
    expect(titles).toContain('Verified bay');
    expect(titles).toContain('Grandfathered bay');
    expect(titles).not.toContain('Unchecked bay');
  });

  test('the saved-spots list applies it too', async () => {
    // This list had no filter at all before — not verification, not even
    // is_active — so it handed a driver unverified spots as bookable cards.
    await prisma.saved_spots.createMany({
      data: [
        { user_id: ids.driver, spot_id: ids.spots.approved },
        { user_id: ids.driver, spot_id: ids.spots.unverified },
      ],
      skipDuplicates: true,
    });

    const res = await request(app).get('/api/v1/saved-spots').set(auth(DRIVER));

    expect(res.status).toBe(200);
    const titles = titlesIn(res.body);
    expect(titles).toContain('Verified bay');
    expect(titles).not.toContain('Unchecked bay');
  });

  test('a booking by spot id is refused, which is what the finder cannot stop', async () => {
    const res = await request(app)
      .post('/api/v1/bookings')
      .set(auth(DRIVER))
      .send({
        spot_id: ids.spots.unverified,
        start_time: new Date(Date.now() + 60_000).toISOString(),
        end_time: new Date(Date.now() + 3_660_000).toISOString(),
      });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).toMatch(/not available for booking yet/);
  });

  test('a grandfathered spot can still be booked — it was live before this existed', async () => {
    const res = await request(app)
      .post('/api/v1/bookings')
      .set(auth(DRIVER))
      .send({
        spot_id: ids.spots.grandfathered,
        start_time: new Date(Date.now() + 60_000).toISOString(),
        end_time: new Date(Date.now() + 3_660_000).toISOString(),
      });

    expect(res.status).toBe(201);
    await prisma.bookings.deleteMany({ where: { spot_id: ids.spots.grandfathered } });
  });
});

describe('a brand new spot is not live, however verified its owner is', () => {
  let newSpotId;

  afterAll(async () => {
    if (newSpotId) {
      await prisma.spot_verifications.deleteMany({ where: { spot_id: newSpotId } });
      await prisma.parking_spots.deleteMany({ where: { id: newSpotId } });
    }
  });

  test('creating a spot leaves it at not_started, with a record of its own', async () => {
    const res = await request(app)
      .post('/api/v1/spots')
      .set(auth(OWNER))
      .send({
        title: 'Freshly listed',
        description: 'new',
        price_per_hour: 50,
        ...PIN,
        address: '2 Verification Street',
        total_slots: 1, car_slots: 1, bike_slots: 0,
      });

    expect(res.status).toBe(201);
    newSpotId = res.body.data.id;

    expect((await spotRow(newSpotId)).spot_verification_status).toBe('not_started');
    // Created with the spot, in the same statement, so there is no such thing
    // as a spot without a record.
    expect((await recordFor(newSpotId)).status).toBe('not_started');
  });

  test('and it does not appear in the finder', async () => {
    const res = await request(app).get(NEARBY);
    expect(titlesIn(res.body)).not.toContain('Freshly listed');
  });
});

// ──────────────────────── the owner's submission ────────────────────────

describe('an owner submits a document for one spot', () => {
  const upload = (who, spotId, fields = {}) => {
    const req = request(app)
      .post(`/api/v1/spot-verification/${spotId}/document`)
      .set(auth(who))
      .field('doc_type', fields.doc_type ?? 'khata_certificate')
      .field('address', fields.address ?? '42 Verification Road, Indiranagar, Bengaluru 560038');
    if (fields.relationship) req.field('relationship', fields.relationship);
    return req.attach('document', Buffer.from('not-really-a-jpeg'), 'khata.jpg');
  };

  test('a document moves the spot to in_progress', async () => {
    const res = await upload(OWNER, ids.spots.unverified);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('in_progress');
    expect(res.body.data.is_live).toBe(false);

    const record = await recordFor(ids.spots.unverified);
    expect(record.doc_type).toBe('khata_certificate');
    expect(record.claimed_address).toMatch(/Indiranagar/);
    expect(record.relationship).toBe('owner');
    expect(record.doc_public_id).toMatch(/^parkstop\/spot-docs\//);
  });

  test('the document id is never sent back to the owner', async () => {
    const res = await request(app)
      .get(`/api/v1/spot-verification/${ids.spots.unverified}`)
      .set(auth(OWNER));

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/spot-docs/);
  });

  test('submitting starts the clock', async () => {
    const res = await request(app)
      .post(`/api/v1/spot-verification/${ids.spots.unverified}/submit`)
      .set(auth(OWNER));

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('desk_pending');
    expect(res.body.data.promised_hours).toBe(48);
    expect(res.body.data.hours_left).toBeGreaterThan(47);
    expect(res.body.data.message).toMatch(/Under review/);

    expect((await recordFor(ids.spots.unverified)).submitted_at).toBeTruthy();
  });

  test('a submitted spot is still not visible — a submission is not a check', async () => {
    const res = await request(app).get(NEARBY);
    expect(titlesIn(res.body)).not.toContain('Unchecked bay');
  });

  test('the document cannot be swapped while someone is reviewing it', async () => {
    const res = await upload(OWNER, ids.spots.unverified);

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/being checked/i);
  });

  test('another owner cannot submit for a spot that is not theirs', async () => {
    const res = await upload(OTHER, ids.spots.grandfathered);

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/your own spots/);
  });

  test('a spot with no document cannot be submitted', async () => {
    const res = await request(app)
      .post(`/api/v1/spot-verification/${ids.spots.rejected}/submit`)
      .set(auth(OWNER));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Add a document/);
  });

  /**
   * The controller checks these too, so a test that only looked for a 400
   * would pass with the route's validators deleted — which is what mutation
   * testing found. The route answers differently: "Validation failed" plus an
   * errors array naming the field, against one message for the request.
   */
  const rejected = [
    ['an unknown document type', 'doc_type', { doc_type: 'selfie_with_car' }],
    ['no document type', 'doc_type', { doc_type: '' }],
    ['an address too short to be an address', 'address', { address: 'Bengaluru' }],
    ['a relationship we do not recognise', 'relationship', { relationship: 'squatter' }],
  ];

  test.each(rejected)('400 for %s, naming that field', async (_label, field, fields) => {
    const res = await upload(OWNER, ids.spots.rejected, fields);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Validation failed');
    expect(res.body.errors.map((e) => e.field)).toContain(field);
  });

  test('a replacement document clears the verdict on the one it replaces', async () => {
    // Stage 2 writes these. A new document means nobody has read THIS one, so
    // leaving them would show an admin a name match and a distance measured
    // against a document that is no longer there.
    await prisma.spot_verifications.update({
      where: { spot_id: ids.spots.rejected },
      data: {
        name_on_document: 'Someone Else',
        name_match: 'DIRECT_MATCH',
        address_match_metres: 12,
        geocoded_lat: 12.9,
        geocoded_lng: 77.5,
        geocode_source: 'nominatim',
        desk_reviewed_by: 1,
        desk_reviewed_at: new Date(),
        rejection_reason: 'the old reason',
      },
    });

    expect((await upload(OWNER, ids.spots.rejected)).status).toBe(200);

    const record = await recordFor(ids.spots.rejected);
    expect(record.name_match).toBeNull();
    expect(record.name_on_document).toBeNull();
    expect(record.address_match_metres).toBeNull();
    expect(record.geocoded_lat).toBeNull();
    expect(record.geocode_source).toBeNull();
    expect(record.desk_reviewed_by).toBeNull();
    expect(record.desk_reviewed_at).toBeNull();
    expect(record.rejection_reason).toBeNull();
  });
});

/**
 * The promise the backfill makes.
 *
 * A spot that was already live moves through in_progress and desk_pending like
 * any other, and a driver may see neither of those. Without grandfathered_at
 * it would drop out of the finder the moment its owner complied.
 */
describe('a grandfathered spot stays visible all the way through its review', () => {
  const uploadFor = (spotId) =>
    request(app)
      .post(`/api/v1/spot-verification/${spotId}/document`)
      .set(auth(OWNER))
      .field('doc_type', 'property_tax')
      .field('address', '9 Grandfather Lane, Jayanagar, Bengaluru 560041')
      .attach('document', Buffer.from('doc'), 'tax.jpg');

  test('visible before anything is submitted', async () => {
    const res = await request(app).get(NEARBY);
    expect(titlesIn(res.body)).toContain('Grandfathered bay');
  });

  test('still visible with a document uploaded', async () => {
    expect((await uploadFor(ids.spots.grandfathered)).status).toBe(200);

    expect((await recordFor(ids.spots.grandfathered)).status).toBe('in_progress');
    // The cached column a driver is filtered on did NOT follow the record.
    expect((await spotRow(ids.spots.grandfathered)).spot_verification_status).toBe('grandfathered');
    expect(titlesIn((await request(app).get(NEARBY)).body)).toContain('Grandfathered bay');
  });

  test('still visible once submitted for review', async () => {
    const res = await request(app)
      .post(`/api/v1/spot-verification/${ids.spots.grandfathered}/submit`)
      .set(auth(OWNER));

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('desk_pending');
    expect(res.body.data.is_live).toBe(true);

    expect((await spotRow(ids.spots.grandfathered)).spot_verification_status).toBe('grandfathered');
    expect(titlesIn((await request(app).get(NEARBY)).body)).toContain('Grandfathered bay');
  });

  test('once submitted it IS on the clock, like anyone else', async () => {
    // Being an early listing is why nobody promised them 48 hours while they
    // sat there unsubmitted. It is not a reason to owe them less once they
    // have done what we asked.
    const res = await request(app)
      .get(`/api/v1/spot-verification/${ids.spots.grandfathered}`)
      .set(auth(OWNER));

    expect(res.body.data.status).toBe('desk_pending');
    expect(res.body.data.waiting_hours).toBeGreaterThanOrEqual(0);
    expect(res.body.data.hours_left).toBeGreaterThan(47);
  });

  test('and it leaves the chasing backlog, so nobody chases it twice', async () => {
    const res = await request(app)
      .get('/api/v1/spot-verification/admin/backlog')
      .set(auth(ADMIN));

    expect(res.body.data.items.map((i) => i.spot_id)).not.toContain(ids.spots.grandfathered);
    expect(res.body.data.submitted_and_in_the_queue).toBeGreaterThanOrEqual(1);
  });
});

// ──────────────────────── the clock and the queue ────────────────────────

describe('the 48-hour promise is measured', () => {
  const queue = (who, qs = '') =>
    request(app).get(`/api/v1/spot-verification/admin/queue${qs}`).set(auth(who));

  const waitedFor = (spotId, hours) =>
    prisma.spot_verifications.update({
      where: { spot_id: spotId },
      data: { submitted_at: new Date(Date.now() - hours * 3600 * 1000) },
    });

  test('an owner cannot read the queue', async () => {
    expect((await queue(OWNER)).status).toBe(403);
  });

  test('a fresh submission is ok, and carries how long is left', async () => {
    await waitedFor(ids.spots.unverified, 1);

    const res = await queue(ADMIN);

    expect(res.status).toBe(200);
    const row = res.body.data.items.find((i) => i.spot_id === ids.spots.unverified);
    expect(row.sla).toBe('ok');
    expect(row.waiting_hours).toBe(1);
    expect(row.hours_left).toBe(47);
    expect(row.stage).toBe('desk');
    expect(row.claimed_address).toMatch(/Indiranagar/);
    expect(row.owner.person_verified).toBe(true);
  });

  test('past 36 hours it is at risk', async () => {
    await waitedFor(ids.spots.unverified, 37);

    const res = await queue(ADMIN);
    const row = res.body.data.items.find((i) => i.spot_id === ids.spots.unverified);

    expect(row.sla).toBe('at_risk');
    expect(res.body.data.counts.at_risk).toBeGreaterThanOrEqual(1);
  });

  test('past 48 hours it is overdue, and says by how much', async () => {
    await waitedFor(ids.spots.unverified, 50);

    const res = await queue(ADMIN);
    const row = res.body.data.items.find((i) => i.spot_id === ids.spots.unverified);

    expect(row.sla).toBe('overdue');
    expect(row.hours_left).toBe(0);
    expect(row.overdue_by_hours).toBeCloseTo(2, 0);
    expect(res.body.data.counts.overdue).toBeGreaterThanOrEqual(1);
  });

  test('the oldest submission is at the top — the order IS the queue', async () => {
    await waitedFor(ids.spots.unverified, 50);
    await waitedFor(ids.spots.grandfathered, 2);

    const res = await queue(ADMIN);
    const spots = res.body.data.items.map((i) => i.spot_id);

    expect(spots.indexOf(ids.spots.unverified)).toBeLessThan(spots.indexOf(ids.spots.grandfathered));
  });

  test('the response says what the promise is, so a screen cannot invent one', async () => {
    const res = await queue(ADMIN);

    expect(res.body.data.promised_hours).toBe(48);
    expect(res.body.data.at_risk_after_hours).toBe(36);
  });

  test('the desk and field queues can be asked for separately', async () => {
    const desk = await queue(ADMIN, '?stage=desk');
    expect(desk.body.data.items.every((i) => i.status === 'desk_pending')).toBe(true);

    const field = await queue(ADMIN, '?stage=field');
    // Only spots that have passed a desk review, which is nothing from this
    // describe. Asserted by content rather than by an empty list, so that
    // later describes creating desk-approved spots cannot break it.
    expect(field.body.data.items.every((i) => i.status === 'desk_approved')).toBe(true);
    expect(field.body.data.items.map((i) => i.spot_id)).not.toContain(ids.spots.unverified);
  });

  test('only spots waiting on us are in it', async () => {
    const res = await queue(ADMIN);
    const spots = res.body.data.items.map((i) => i.spot_id);

    expect(spots).not.toContain(ids.spots.approved);
    expect(spots).not.toContain(ids.spots.rejected);
  });
});

describe('the grandfathered backlog is counted separately', () => {
  test('it lists the spots that were live before any of this existed', async () => {
    const res = await request(app)
      .get('/api/v1/spot-verification/admin/backlog')
      .set(auth(ADMIN));

    expect(res.status).toBe(200);
    const spots = res.body.data.items.map((i) => i.spot_id);
    expect(spots).toContain(ids.spots.grandfatheredUntouched);
    expect(spots).not.toContain(ids.spots.approved);
    expect(spots).not.toContain(ids.spots.unverified);
    expect(res.body.data.count).toBeGreaterThanOrEqual(1);
    // It says what it is, rather than looking like a list of verified spots.
    expect(res.body.data.note).toMatch(/Unchecked/i);
  });

  test('an owner cannot read it', async () => {
    const res = await request(app)
      .get('/api/v1/spot-verification/admin/backlog')
      .set(auth(OWNER));

    expect(res.status).toBe(403);
  });
});

describe('what an admin gets for one spot', () => {
  test('the document, the name to compare it against, and the log', async () => {
    const res = await request(app)
      .get(`/api/v1/spot-verification/admin/${ids.spots.unverified}`)
      .set(auth(ADMIN));

    expect(res.status).toBe(200);
    // A signed URL, because the document is private.
    expect(res.body.data.submission.doc_url).toMatch(/^https:\/\/signed\.test\//);
    expect(res.body.data.spot.latitude).toBeTruthy();
    expect(res.body.data.owner.person_verified).toBe(true);
    // Stage 2 fills these in; they exist and are empty, not absent.
    expect(res.body.data.desk).toMatchObject({ name_match: null, address_match_metres: null });
    expect(res.body.data.review_log.map((e) => e.action)).toEqual(
      expect.arrayContaining(['document_uploaded', 'submitted'])
    );
  });

  test('an owner cannot read the admin view of their own spot', async () => {
    const res = await request(app)
      .get(`/api/v1/spot-verification/admin/${ids.spots.unverified}`)
      .set(auth(OWNER));

    expect(res.status).toBe(403);
  });
});

// ──────────────────────── the owner's own screens ────────────────────────

describe('the owner can see where each spot stands', () => {
  test('the dashboard carries the state per spot, in the same shape', async () => {
    const res = await request(app).get('/api/v1/spots/dashboard').set(auth(OWNER));

    expect(res.status).toBe(200);
    const byId = new Map(res.body.data.inventory.map((s) => [s.id, s]));

    expect(byId.get(ids.spots.approved).verification).toMatchObject({
      status: 'approved', is_live: true, pin_locked: true,
    });
    expect(byId.get(ids.spots.unverified).verification).toMatchObject({
      status: 'desk_pending', is_live: false,
    });
    expect(byId.get(ids.spots.grandfathered).verification).toMatchObject({
      visible_to_drivers: 'grandfathered', is_live: true,
    });
    // The whole point of putting it here: the owner can tell a live listing
    // from a dead one without guessing.
    expect(byId.get(ids.spots.unverified).verification.message).toMatch(/Under review/);
  });

  test('the dashboard does not carry the document id', async () => {
    const res = await request(app).get('/api/v1/spots/dashboard').set(auth(OWNER));
    expect(JSON.stringify(res.body)).not.toMatch(/spot-docs/);
  });

  test('a spot that is not theirs is not readable', async () => {
    const res = await request(app)
      .get(`/api/v1/spot-verification/${ids.spots.foreign}`)
      .set(auth(OWNER));

    expect(res.status).toBe(403);
  });
});

// ──────────────────────── the pin, re-keyed ────────────────────────

describe('the pin freeze follows the spot, not the owner', () => {
  const movePin = (spotId) =>
    request(app)
      .put(`/api/v1/spots/${spotId}`)
      .set(auth(OWNER))
      .send({ latitude: 28.61, longitude: 77.20 });

  test('a live spot cannot be moved', async () => {
    const res = await movePin(ids.spots.approved);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cannot be moved while it is live/);
  });

  test('a spot under review cannot be moved either', async () => {
    // The desk check measures the document's address against this pin.
    const res = await movePin(ids.spots.unverified);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/while we are checking its address/);
  });

  test('a rejected spot CAN be moved, so a wrong pin is fixable', async () => {
    const res = await movePin(ids.spots.rejected);

    expect(res.status).toBe(200);
    expect(Number((await spotRow(ids.spots.rejected)).latitude)).toBeCloseTo(28.61, 4);
  });
});

// ──────────────────────── stage 2: the desk review ────────────────────────

/**
 * An admin reads the document. Two checks help them: is this the same person,
 * and is this the same place. Neither decides — a desk pass sends the spot to
 * the FIELD stage, not live, because a desk review cannot prove a document is
 * genuine.
 */
describe('the desk review', () => {
  const { geocodeAddress } = require('../../src/services/geocoding');
  const { PRECISION } = jest.requireActual('../../src/services/geocoding');

  /** A geocoder answer, positioned relative to the spot's pin. */
  const resolvesTo = ({ metresNorth = 0, precision = PRECISION.STREET, uncertainty = 150, source = 'nominatim' }) => {
    geocodeAddress.mockResolvedValue({
      lat: String(PIN.latitude + metresNorth / 110540),
      lon: String(PIN.longitude),
      precision,
      uncertainty_m: uncertainty,
      source,
      display_name: 'Somewhere, Bengaluru',
      bbox: null,
      place_rank: 26,
      kind: 'highway/residential',
    });
  };
  const resolvesToNothing = () => geocodeAddress.mockResolvedValue(null);

  /** A spot sitting in desk_pending, owned by the approved OWNER. */
  async function submittedSpot(title, over = {}) {
    const id = await makeSpot(ids.owner, title, 'not_started');
    await prisma.spot_verifications.update({
      where: { spot_id: id },
      data: {
        status: 'desk_pending',
        submitted_at: new Date(),
        doc_type: 'khata_certificate',
        doc_public_id: 'parkstop/spot-docs/mock-desk',
        claimed_address: '42 Verification Road, Indiranagar, Bengaluru 560038',
        relationship: 'owner',
        ...over,
      },
    });
    ids.spots[title] = id;
    return id;
  }

  const check = (spotId, body = {}) =>
    request(app).post(`/api/v1/spot-verification/admin/${spotId}/check`).set(auth(ADMIN)).send(body);
  const decide = (spotId, body) =>
    request(app).post(`/api/v1/spot-verification/admin/${spotId}/desk`).set(auth(ADMIN)).send(body);

  beforeAll(async () => {
    // The desk review compares the document's name against the owner's
    // verified Aadhaar name, so the owner needs one.
    await prisma.owner_verifications.upsert({
      where: { user_id: ids.owner },
      update: { aadhaar_name: 'Rajesh Kumar' },
      create: { user_id: ids.owner, status: 'approved', aadhaar_name: 'Rajesh Kumar' },
    });
  });

  afterAll(async () => {
    await prisma.owner_verifications.deleteMany({ where: { user_id: ids.owner } });
  });

  beforeEach(() => jest.clearAllMocks());

  describe('running the checks without deciding', () => {
    test('it stores the distance, the precision and the verdict', async () => {
      const id = await submittedSpot('desk-check');
      resolvesTo({ metresNorth: 80 });

      const res = await check(id, { name_on_document: 'Shri Rajesh Kumar' });

      expect(res.status).toBe(200);
      expect(res.body.data.address.verdict).toBe('consistent');
      expect(res.body.data.address.metres).toBeCloseTo(80, 0);
      expect(res.body.data.name.verdict).toBe('DIRECT_MATCH');
      expect(res.body.data.blockers).toEqual([]);

      const record = await recordFor(id);
      expect(record.address_match_metres).toBe(80);
      expect(record.address_match_verdict).toBe('consistent');
      expect(record.geocode_precision).toBe('street');
      expect(record.geocode_uncertainty_m).toBe(150);
      expect(Number(record.geocoded_lat)).toBeCloseTo(PIN.latitude + 80 / 110540, 6);
      expect(record.name_match).toBe('DIRECT_MATCH');
      // It decided nothing.
      expect(record.status).toBe('desk_pending');
      expect(record.desk_reviewed_at).toBeNull();
    });

    test('it says plainly that none of this proves the document is genuine', async () => {
      const id = await submittedSpot('desk-reminder');
      resolvesTo({ metresNorth: 10 });

      const res = await check(id);

      expect(res.body.data.reminder).toMatch(/cannot tell you whether the document is genuine/i);
      expect(res.body.data.reminder).toMatch(/field check/i);
    });

    test('a locality-sized hit is reported as unverifiable, not as agreement', async () => {
      // What most Indian addresses actually resolve to.
      const id = await submittedSpot('desk-coarse');
      resolvesTo({ metresNorth: 300, precision: PRECISION.LOCALITY, uncertainty: 2200 });

      const res = await check(id);

      expect(res.body.data.address.verdict).toBe('unverifiable');
      expect(res.body.data.address.explanation).toMatch(/neither confirms nor contradicts/);
      // And it does not stand in the way of a pass. (Typing no name is its own
      // blocker, which is why this looks at the address codes only.)
      expect(res.body.data.blockers.map((b) => b.code).filter((c) => c.startsWith('ADDRESS_'))).toEqual([]);
    });

    test('an address that resolves nowhere is a blocker, not a pass', async () => {
      const id = await submittedSpot('desk-unresolved');
      resolvesToNothing();

      const res = await check(id, { name_on_document: 'Rajesh Kumar' });

      expect(res.body.data.address.verdict).toBe('unresolved');
      expect(res.body.data.blockers.map((b) => b.code)).toContain('ADDRESS_UNRESOLVED');
      expect((await recordFor(id)).address_match_metres).toBeNull();
    });

    test('an owner cannot run the checks', async () => {
      const id = await submittedSpot('desk-forbidden');
      expect((await request(app).post(`/api/v1/spot-verification/admin/${id}/check`).set(auth(OWNER))).status).toBe(403);
    });
  });

  describe('passing', () => {
    test('a clean pass sends the spot to the field stage, not live', async () => {
      const id = await submittedSpot('desk-pass');
      resolvesTo({ metresNorth: 60 });

      const res = await decide(id, { decision: 'pass', name_on_document: 'Rajesh Kumar' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('desk_approved');
      expect(res.body.data.next).toMatch(/not visible to drivers until that passes/);

      const record = await recordFor(id);
      expect(record.status).toBe('desk_approved');
      expect(record.desk_reviewed_by).toBeTruthy();
      expect(record.desk_reviewed_at).toBeTruthy();
      expect(record.desk_override_reason).toBeNull();
      expect(record.name_on_document).toBe('Rajesh Kumar');
      expect(record.address_match_verdict).toBe('consistent');

      // The thing that matters: a desk pass is not visibility.
      expect((await spotRow(id)).spot_verification_status).toBe('desk_approved');
      expect(titlesIn((await request(app).get(NEARBY)).body)).not.toContain('desk-pass');
    });

    test('the decision re-measures rather than trusting what was stored', async () => {
      const id = await submittedSpot('desk-remeasure');
      // A check that found it close by...
      resolvesTo({ metresNorth: 20 });
      await check(id, { name_on_document: 'Rajesh Kumar' });
      expect((await recordFor(id)).address_match_metres).toBe(20);

      // ...and a decision taken when it resolves somewhere else entirely.
      resolvesTo({ metresNorth: 4000 });
      const res = await decide(id, { decision: 'pass', name_on_document: 'Rajesh Kumar' });

      expect(res.status).toBe(409);
      expect(res.body.blockers.map((b) => b.code)).toContain('ADDRESS_MISMATCH');
      expect((await recordFor(id)).status).toBe('desk_pending');
    });

    test('a name that is not the same person blocks the pass', async () => {
      const id = await submittedSpot('desk-name-block');
      resolvesTo({ metresNorth: 10 });

      const res = await decide(id, { decision: 'pass', name_on_document: 'Amit Sharma' });

      expect(res.status).toBe(409);
      expect(res.body.blockers.map((b) => b.code)).toEqual(['NAME_NO_MATCH']);
      expect(res.body.how_to_proceed).toMatch(/override_reason/);
      expect((await recordFor(id)).status).toBe('desk_pending');
    });

    test('a shared surname with a different given name BLOCKS', async () => {
      // "Suresh Kumar" against a verified "Rajesh Kumar". This used to pass
      // outright: it came out MODERATE_PARTIAL_MATCH, which does not block, so
      // a document in a different person's name verified the spot with no
      // override and nothing in the log. Kumar is one of the commonest
      // surnames in India, so the hole was wide open.
      const id = await submittedSpot('desk-moderate');
      resolvesTo({ metresNorth: 10 });

      const res = await decide(id, { decision: 'pass', name_on_document: 'Suresh Kumar' });

      expect(res.status).toBe(409);
      expect(res.body.blockers.map((b) => b.code)).toEqual(['NAME_NO_MATCH']);
      expect(res.body.name.conflicting).toBe(1);
      expect((await recordFor(id)).status).toBe('desk_pending');
    });

    test('a name that merely says less still passes, without an override', async () => {
      // The case the old comparator could not tell apart from the one above,
      // and the reason the fix is about CONTRADICTION rather than a percentage:
      // "Rajesh" agrees with "Rajesh Kumar" as far as it goes. Short names are
      // ordinary on Indian documents and must not need an override.
      const id = await submittedSpot('desk-containment');
      resolvesTo({ metresNorth: 10 });

      const res = await decide(id, { decision: 'pass', name_on_document: 'Rajesh' });

      expect(res.status).toBe(200);
      expect(res.body.data.name.verdict).toBe('MODERATE_PARTIAL_MATCH');
      expect(res.body.data.name.conflicting).toBe(0);
      expect((await recordFor(id)).name_match).toBe('MODERATE_PARTIAL_MATCH');
    });

    test('an owner-occupied spot is checked against the Aadhaar name, and says so', async () => {
      const id = await submittedSpot('desk-checked-against');
      resolvesTo({ metresNorth: 10 });

      const res = await decide(id, { decision: 'pass', name_on_document: 'Rajesh Kumar' });

      expect(res.status).toBe(200);
      expect(res.body.data.name.checked_against).toBe('aadhaar_name');
      expect((await recordFor(id)).name_checked_against).toBe('aadhaar_name');
    });

    test('an override is allowed, and is recorded against the spot', async () => {
      const id = await submittedSpot('desk-override');
      resolvesTo({ metresNorth: 4000 });

      const res = await decide(id, {
        decision: 'pass',
        name_on_document: 'Rajesh Kumar',
        override_reason: 'Bill is for the same plot; the street was renamed last year. Checked with the owner by phone.',
      });

      expect(res.status).toBe(200);
      expect(res.body.data.overridden).toEqual(['ADDRESS_MISMATCH']);

      const record = await recordFor(id);
      expect(record.status).toBe('desk_approved');
      expect(record.desk_override_reason).toMatch(/street was renamed/);
      // A pass that needed an override is not the same as a clean pass, and
      // the log says which it was.
      expect(record.review_log.map((e) => e.action)).toContain('passed_with_override');
    });

    test('a one-word override is not a reason', async () => {
      const id = await submittedSpot('desk-weak-override');
      resolvesTo({ metresNorth: 4000 });

      const res = await decide(id, { decision: 'pass', name_on_document: 'Rajesh Kumar', override_reason: 'fine' });

      expect(res.status).toBe(409);
      expect((await recordFor(id)).status).toBe('desk_pending');
    });

    test('the name has to be typed', async () => {
      const id = await submittedSpot('desk-no-name');
      resolvesTo({ metresNorth: 10 });

      const res = await decide(id, { decision: 'pass' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/name printed on the document/);
    });

    test('a place cannot be verified in the name of a person who is not', async () => {
      // There is no name to check the document against, so this one does not
      // yield to an override.
      const id = await submittedSpot('desk-person-unverified');
      await prisma.users.update({ where: { id: ids.owner }, data: { verification_status: 'pending' } });
      resolvesTo({ metresNorth: 10 });

      const res = await decide(id, {
        decision: 'pass',
        name_on_document: 'Rajesh Kumar',
        override_reason: 'I am sure about this one, honestly, it is fine.',
      });

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/Verify the person before verifying their property/);

      await prisma.users.update({ where: { id: ids.owner }, data: { verification_status: 'approved' } });
    });

    test('a grandfathered spot that passes the desk stays visible', async () => {
      // It was live before any of this existed, and a desk pass is progress,
      // not a reason to take it off the map while the field check is pending.
      const id = await makeSpot(ids.owner, 'desk-grandfathered', 'grandfathered');
      ids.spots['desk-grandfathered'] = id;
      await prisma.spot_verifications.update({
        where: { spot_id: id },
        data: {
          status: 'desk_pending',
          submitted_at: new Date(),
          doc_type: 'property_tax',
          doc_public_id: 'parkstop/spot-docs/mock-gf',
          claimed_address: '9 Grandfather Lane, Jayanagar, Bengaluru 560041',
        },
      });
      resolvesTo({ metresNorth: 40 });

      const res = await decide(id, { decision: 'pass', name_on_document: 'Rajesh Kumar' });

      expect(res.status).toBe(200);
      expect((await recordFor(id)).status).toBe('desk_approved');
      expect((await spotRow(id)).spot_verification_status).toBe('grandfathered');
      expect(titlesIn((await request(app).get(NEARBY)).body)).toContain('desk-grandfathered');
    });
  });

  describe('rejecting', () => {
    test('a rejection carries a reason the owner can act on', async () => {
      const id = await submittedSpot('desk-reject');
      resolvesTo({ metresNorth: 9000 });

      const res = await decide(id, {
        decision: 'reject',
        reason: 'The electricity bill is for a different street. Send one for this address.',
      });

      expect(res.status).toBe(200);
      const record = await recordFor(id);
      expect(record.status).toBe('rejected');
      expect(record.rejection_reason).toMatch(/different street/);
      expect(record.desk_reviewed_by).toBeTruthy();

      // The owner sees it, in their own words, on their own screen.
      const mine = await request(app).get(`/api/v1/spot-verification/${id}`).set(auth(OWNER));
      expect(mine.body.data.rejection_reason).toMatch(/different street/);
      expect(mine.body.data.message).toMatch(/could not verify/i);
    });

    test('a rejected spot leaves the finder, and its pin becomes movable again', async () => {
      const id = await submittedSpot('desk-reject-pin');
      await prisma.parking_spots.update({ where: { id }, data: { spot_verification_status: 'grandfathered' } });
      await prisma.spot_verifications.update({ where: { spot_id: id }, data: { grandfathered_at: new Date() } });

      await decide(id, { decision: 'reject', reason: 'The document names a different person entirely.' });

      expect((await spotRow(id)).spot_verification_status).toBe('rejected');
      expect(titlesIn((await request(app).get(NEARBY)).body)).not.toContain('desk-reject-pin');

      // So "your pin is in the wrong place" is a rejection the owner can act on.
      const moved = await request(app)
        .put(`/api/v1/spots/${id}`)
        .set(auth(OWNER))
        .send({ latitude: 28.61, longitude: 77.2 });
      expect(moved.status).toBe(200);
    });

    test('a rejection needs more than a shrug', async () => {
      const id = await submittedSpot('desk-reject-thin');

      const res = await decide(id, { decision: 'reject', reason: 'no' });

      expect(res.status).toBe(400);
      expect((await recordFor(id)).status).toBe('desk_pending');
    });
  });

  describe('what can be decided', () => {
    test('only a submission waiting for a desk review', async () => {
      const id = await submittedSpot('desk-twice');
      resolvesTo({ metresNorth: 10 });
      expect((await decide(id, { decision: 'pass', name_on_document: 'Rajesh Kumar' })).status).toBe(200);

      const again = await decide(id, { decision: 'pass', name_on_document: 'Rajesh Kumar' });

      expect(again.status).toBe(409);
      expect(again.body.message).toMatch(/desk_approved/);
    });

    test('a decision that is neither pass nor reject is refused by the route', async () => {
      const id = await submittedSpot('desk-nonsense');

      const res = await decide(id, { decision: 'maybe', name_on_document: 'Rajesh Kumar' });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Validation failed');
      expect(res.body.errors.map((e) => e.field)).toContain('decision');
    });

    test('an owner cannot decide on their own spot', async () => {
      const id = await submittedSpot('desk-owner-decides');

      const res = await request(app)
        .post(`/api/v1/spot-verification/admin/${id}/desk`)
        .set(auth(OWNER))
        .send({ decision: 'pass', name_on_document: 'Rajesh Kumar' });

      expect(res.status).toBe(403);
    });
  });

  test('the admin detail view explains the stored numbers', async () => {
    const id = await submittedSpot('desk-detail');
    resolvesTo({ metresNorth: 300, precision: PRECISION.LOCALITY, uncertainty: 2200 });
    await check(id, { name_on_document: 'Rajesh Kumar' });

    const res = await request(app).get(`/api/v1/spot-verification/admin/${id}`).set(auth(ADMIN));

    expect(res.status).toBe(200);
    expect(res.body.data.desk.geocode_precision).toBe('locality');
    expect(res.body.data.desk.geocode_uncertainty_m).toBe(2200);
    expect(res.body.data.desk.address_match_verdict).toBe('unverifiable');
    // The sentence, so a screen does not have to reimplement the bands.
    expect(res.body.data.desk.reading).toMatch(/neither confirms nor contradicts/);
  });
});

// ──────────────────── stage 3: the field check and tenants ────────────────────

/**
 * The field check is the only thing that can make a spot live, and the only
 * step that tests something a forger cannot print.
 */
describe('the field check', () => {
  const { geocodeAddress } = require('../../src/services/geocoding');
  const { PRECISION } = jest.requireActual('../../src/services/geocoding');

  const resolvesNear = () => geocodeAddress.mockResolvedValue({
    lat: String(PIN.latitude + 0.0005), lon: String(PIN.longitude),
    precision: PRECISION.STREET, uncertainty_m: 150, source: 'nominatim',
    display_name: 'Somewhere, Bengaluru', bbox: null, place_rank: 26, kind: 'highway/residential',
  });

  /** A spot that has passed its desk review and is waiting for the field. */
  async function deskApprovedSpot(title, over = {}) {
    const id = await makeSpot(ids.owner, title, 'not_started');
    ids.spots[title] = id;
    await prisma.spot_verifications.update({
      where: { spot_id: id },
      data: {
        status: 'desk_approved',
        submitted_at: new Date(),
        doc_type: 'khata_certificate',
        doc_public_id: 'parkstop/spot-docs/mock-field',
        claimed_address: '42 Verification Road, Indiranagar, Bengaluru 560038',
        relationship: 'owner',
        name_on_document: 'Rajesh Kumar',
        name_match: 'DIRECT_MATCH',
        address_match_metres: 55,
        address_match_verdict: 'consistent',
        desk_reviewed_by: ids.owner,
        desk_reviewed_at: new Date(),
        ...over,
      },
    });
    return id;
  }

  const field = (spotId, body) =>
    request(app).post(`/api/v1/spot-verification/admin/${spotId}/field`).set(auth(ADMIN)).send(body);

  const FOUND = {
    decision: 'pass',
    office: 'Sub-Registrar Office, Indiranagar',
    record_found: true,
    reference: 'SRO/IND/2019/4471',
    notes: 'Khata in the same name. Clerk confirmed the survey number.',
  };

  beforeAll(async () => {
    await prisma.owner_verifications.upsert({
      where: { user_id: ids.owner },
      update: { aadhaar_name: 'Rajesh Kumar' },
      create: { user_id: ids.owner, status: 'approved', aadhaar_name: 'Rajesh Kumar' },
    });
  });

  afterAll(async () => {
    await prisma.owner_verifications.deleteMany({ where: { user_id: ids.owner } });
  });

  beforeEach(() => jest.clearAllMocks());

  describe('a record that was found', () => {
    test('the spot goes live, and that is the only route to live', async () => {
      const id = await deskApprovedSpot('field-pass');

      const res = await field(id, FOUND);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('approved');
      expect(res.body.data.visible_to_drivers).toBe('approved');

      const record = await recordFor(id);
      expect(record.status).toBe('approved');
      expect(record.field_office).toBe(FOUND.office);
      expect(record.field_record_found).toBe(true);
      expect(record.field_reference).toBe(FOUND.reference);
      expect(record.field_notes).toMatch(/survey number/);
      expect(record.field_checked_by).toBeTruthy();
      expect(record.field_checked_at).toBeTruthy();

      // Live to drivers, at last.
      expect((await spotRow(id)).spot_verification_status).toBe('approved');
      expect(titlesIn((await request(app).get(NEARBY)).body)).toContain('field-pass');
    });

    test('the response says what "approved" means, and what it does not', async () => {
      const id = await deskApprovedSpot('field-means');

      const res = await field(id, FOUND);

      expect(res.body.data.means).toMatch(/found the record at the regional office/);
      expect(res.body.data.means).toMatch(/does not mean the document is genuine/);
    });

    test('a found record needs a reference — "trust me" is not a record', async () => {
      const id = await deskApprovedSpot('field-no-ref');

      const res = await field(id, { ...FOUND, reference: '' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/registration reference/);
      expect((await recordFor(id)).status).toBe('desk_approved');
    });

    test('the office that was checked is recorded, or nothing is', async () => {
      const id = await deskApprovedSpot('field-no-office');

      const res = await field(id, { ...FOUND, office: '' });

      expect(res.status).toBe(400);
      expect((await recordFor(id)).field_checked_at).toBeNull();
    });

    test('the owner is told their spot is live', async () => {
      const id = await deskApprovedSpot('field-owner-view');
      await field(id, FOUND);

      const mine = await request(app).get(`/api/v1/spot-verification/${id}`).set(auth(OWNER));

      expect(mine.body.data.status).toBe('approved');
      expect(mine.body.data.is_live).toBe(true);
      expect(mine.body.data.message).toMatch(/Verified/);
      expect(mine.body.data.waiting_hours).toBeNull();
    });

    test('and the pin is frozen again, because drivers are navigating to it', async () => {
      const id = await deskApprovedSpot('field-pin');
      await field(id, FOUND);

      const moved = await request(app)
        .put(`/api/v1/spots/${id}`)
        .set(auth(OWNER))
        .send({ latitude: 28.61, longitude: 77.2 });

      expect(moved.status).toBe(400);
      expect(moved.body.message).toMatch(/cannot be moved while it is live/);
    });
  });

  describe('a record that was not found', () => {
    test('it is recorded as a finding, with a reason the owner can act on', async () => {
      const id = await deskApprovedSpot('field-fail');

      const res = await field(id, {
        office: 'Sub-Registrar Office, Indiranagar',
        record_found: false,
        notes: 'No khata under this survey number. Clerk checked 2015-2026.',
        reason: 'We could not find a property record for this address at the local office.',
      });

      expect(res.status).toBe(200);
      const record = await recordFor(id);
      expect(record.status).toBe('rejected');
      // "We went and found nothing" is a finding, written down with the office
      // so the next person does not repeat the visit.
      expect(record.field_office).toBe('Sub-Registrar Office, Indiranagar');
      expect(record.field_record_found).toBe(false);
      expect(record.field_checked_at).toBeTruthy();
      expect(record.field_notes).toMatch(/No khata/);
      expect(record.rejection_reason).toMatch(/could not find a property record/);

      expect(titlesIn((await request(app).get(NEARBY)).body)).not.toContain('field-fail');
    });

    test('the owner sees the reason, not the internal notes', async () => {
      const id = await deskApprovedSpot('field-fail-privacy');
      await field(id, {
        office: 'SRO Indiranagar',
        record_found: false,
        notes: 'Clerk suspects the document is fabricated; flagged internally.',
        reason: 'We could not find a property record for this address.',
      });

      const mine = await request(app).get(`/api/v1/spot-verification/${id}`).set(auth(OWNER));

      expect(mine.body.data.rejection_reason).toMatch(/could not find a property record/);
      expect(JSON.stringify(mine.body)).not.toMatch(/fabricated|flagged internally/);
    });

    test('a failure needs a reason', async () => {
      const id = await deskApprovedSpot('field-fail-thin');

      const res = await field(id, { office: 'SRO Indiranagar', record_found: false, reason: 'no' });

      expect(res.status).toBe(400);
      expect((await recordFor(id)).status).toBe('desk_approved');
    });
  });

  describe('both stages, in order', () => {
    test('a spot waiting for its desk review cannot have a field check', async () => {
      // A visit made on the strength of a document nobody has read.
      const id = await makeSpot(ids.owner, 'field-too-early', 'not_started');
      ids.spots['field-too-early'] = id;
      await prisma.spot_verifications.update({
        where: { spot_id: id },
        data: { status: 'desk_pending', submitted_at: new Date(), doc_public_id: 'x', claimed_address: 'somewhere long enough' },
      });

      const res = await field(id, FOUND);

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/desk review has to pass before the field check/);
      expect((await recordFor(id)).field_checked_at).toBeNull();
    });

    test('an already-approved spot cannot be field-checked again', async () => {
      const id = await deskApprovedSpot('field-twice');
      expect((await field(id, FOUND)).status).toBe(200);

      const again = await field(id, FOUND);

      expect(again.status).toBe(409);
      expect(again.body.message).toMatch(/approved/);
    });

    test('record_found must be said, not left to a default', async () => {
      const id = await deskApprovedSpot('field-no-answer');

      const res = await field(id, { office: 'SRO Indiranagar' });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Validation failed');
      expect(res.body.errors.map((e) => e.field)).toContain('record_found');
    });

    test('a string "true" is not an answer either', async () => {
      const id = await deskApprovedSpot('field-string-true');

      const res = await field(id, { office: 'SRO Indiranagar', record_found: 'true', reference: 'X/1' });

      expect(res.status).toBe(400);
      // Refused at the DOOR, by the strict boolean validator, not downstream:
      // the controller re-checks as well (see the unit test for its own
      // guards), so a test that only looked for a 400 would pass with the
      // route's strictness removed.
      expect(res.body.message).toBe('Validation failed');
      expect(res.body.errors.map((e) => e.field)).toContain('record_found');
      expect((await recordFor(id)).status).toBe('desk_approved');
    });

    test('a status of desk_approved with no desk review behind it cannot publish', async () => {
      // The belt to the status check's braces. The desk endpoint always stamps
      // desk_reviewed_at, so this state is unreachable through the API today —
      // which is exactly why it is worth pinning: a future second path to
      // desk_approved must not be able to publish a spot nobody read.
      const id = await deskApprovedSpot('field-no-desk-stamp', { desk_reviewed_at: null, desk_reviewed_by: null });

      const res = await field(id, FOUND);

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/has not passed both checks/);
      expect((await recordFor(id)).status).toBe('desk_approved');
      expect((await spotRow(id)).spot_verification_status).not.toBe('approved');
    });

    test('an owner cannot record a field check on their own spot', async () => {
      const id = await deskApprovedSpot('field-owner-records');

      const res = await request(app)
        .post(`/api/v1/spot-verification/admin/${id}/field`)
        .set(auth(OWNER))
        .send(FOUND);

      expect(res.status).toBe(403);
      expect((await recordFor(id)).status).toBe('desk_approved');
    });

    test('the field queue is the spots waiting for a visit', async () => {
      const id = await deskApprovedSpot('field-queued');

      const res = await request(app)
        .get('/api/v1/spot-verification/admin/queue?stage=field')
        .set(auth(ADMIN));

      const rows = res.body.data.items.filter((i) => i.spot_id === id);
      expect(rows).toHaveLength(1);
      expect(rows[0].stage).toBe('field');
      // Still on the clock: the owner was promised a live spot, not a desk pass.
      expect(rows[0].waiting_hours).not.toBeNull();
    });
  });

  test('a grandfathered spot that passes the field check becomes properly approved', async () => {
    const id = await makeSpot(ids.owner, 'field-grandfathered', 'grandfathered');
    ids.spots['field-grandfathered'] = id;
    await prisma.spot_verifications.update({
      where: { spot_id: id },
      data: {
        status: 'desk_approved',
        submitted_at: new Date(),
        doc_public_id: 'parkstop/spot-docs/mock-gf2',
        claimed_address: '9 Grandfather Lane, Jayanagar, Bengaluru 560041',
        desk_reviewed_by: ids.owner,
        desk_reviewed_at: new Date(),
      },
    });

    await field(id, FOUND);

    // It was visible all along; now it is visible for a reason.
    expect((await spotRow(id)).spot_verification_status).toBe('approved');
    expect((await recordFor(id)).grandfathered_at).toBeTruthy();
    expect(titlesIn((await request(app).get(NEARBY)).body)).toContain('field-grandfathered');
  });

  test('the admin detail view carries the field result and the whole log', async () => {
    const id = await deskApprovedSpot('field-detail');
    resolvesNear();
    await field(id, FOUND);

    const res = await request(app).get(`/api/v1/spot-verification/admin/${id}`).set(auth(ADMIN));

    expect(res.body.data.field).toMatchObject({
      office: FOUND.office,
      record_found: true,
      reference: FOUND.reference,
    });
    expect(res.body.data.field.checked_at).toBeTruthy();
    expect(res.body.data.review_log.map((e) => e.action)).toContain('record_found');
  });
});

/**
 * Tenants are allowed, with the landlord's written consent.
 *
 * Worth being clear about what that consent is worth: we hold a letter and a
 * name, neither checked against any record. It is the weakest evidence in the
 * flow, and it is required rather than trusted.
 */
describe('a tenant needs the landlord\'s consent', () => {
  const uploadDoc = (spotId, over = {}) =>
    request(app)
      .post(`/api/v1/spot-verification/${spotId}/document`)
      .set(auth(OWNER))
      .field('doc_type', over.doc_type ?? 'rent_agreement')
      .field('address', over.address ?? '42 Tenant Road, Indiranagar, Bengaluru 560038')
      .field('relationship', over.relationship ?? 'tenant')
      .attach('document', Buffer.from('rent agreement'), 'agreement.jpg');

  const uploadNoc = (spotId, over = {}) => {
    const req = request(app)
      .post(`/api/v1/spot-verification/${spotId}/landlord-noc`)
      .set(auth(OWNER));
    if (over.landlord_name !== undefined) req.field('landlord_name', over.landlord_name);
    else req.field('landlord_name', 'Ramesh Gupta');
    return over.noFile ? req : req.attach('document', Buffer.from('noc letter'), 'noc.jpg');
  };

  const submit = (spotId) =>
    request(app).post(`/api/v1/spot-verification/${spotId}/submit`).set(auth(OWNER));

  async function tenantSpot(title) {
    const id = await makeSpot(ids.owner, title, 'not_started');
    ids.spots[title] = id;
    return id;
  }

  test('a tenant submission without the letter is refused', async () => {
    const id = await tenantSpot('tenant-no-noc');
    expect((await uploadDoc(id)).status).toBe(200);

    const res = await submit(id);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/rented, so we need the letter from your landlord/);
    expect(res.body.message).toMatch(/landlord's name/);
    // The clock never started.
    expect((await recordFor(id)).submitted_at).toBeNull();
  });

  test('a rent agreement needs the letter even if the owner ticked "owner"', async () => {
    // A rent agreement IS a tenant's document, whatever was ticked.
    const id = await tenantSpot('tenant-mislabelled');
    expect((await uploadDoc(id, { relationship: 'owner' })).status).toBe(200);

    const res = await submit(id);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/rented/);
  });

  test('a stated tenant needs it even with an ownership document', async () => {
    // The landlord's khata is exactly what a tenant is SUPPOSED to submit —
    // it is the landlord's document, which is the point. It still proves
    // nothing about whether the landlord agreed, so the letter is still
    // required. The relationship decides this, not the document type.
    const id = await tenantSpot('tenant-with-khata');
    expect((await uploadDoc(id, { doc_type: 'khata_certificate', relationship: 'tenant' })).status).toBe(200);

    expect((await submit(id)).status).toBe(400);
  });

  test('with the letter and the name, it submits', async () => {
    const id = await tenantSpot('tenant-complete');
    await uploadDoc(id);

    const noc = await uploadNoc(id);
    expect(noc.status).toBe(200);

    const record = await recordFor(id);
    expect(record.landlord_noc_public_id).toMatch(/^parkstop\/spot-docs\//);
    expect(record.landlord_name).toBe('Ramesh Gupta');

    const res = await submit(id);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('desk_pending');
  });

  test('the letter needs a name on it', async () => {
    const id = await tenantSpot('tenant-noc-no-name');
    await uploadDoc(id);

    const res = await uploadNoc(id, { landlord_name: '' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Validation failed');
    expect(res.body.errors.map((e) => e.field)).toContain('landlord_name');
  });

  test('the letter needs to be a letter', async () => {
    const id = await tenantSpot('tenant-noc-no-file');
    await uploadDoc(id);

    const res = await uploadNoc(id, { noFile: true });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/photo of the letter/);
  });

  test('an owner-occupied spot needs no letter', async () => {
    const id = await tenantSpot('owner-no-noc-needed');
    await uploadDoc(id, { doc_type: 'khata_certificate', relationship: 'owner' });

    expect((await submit(id)).status).toBe(200);
  });

  test('another owner cannot attach a letter to a spot that is not theirs', async () => {
    const id = await tenantSpot('tenant-foreign-noc');

    const res = await request(app)
      .post(`/api/v1/spot-verification/${id}/landlord-noc`)
      .set(auth(OTHER))
      .field('landlord_name', 'Ramesh Gupta')
      .attach('document', Buffer.from('noc'), 'noc.jpg');

    expect(res.status).toBe(403);
  });

  test('the letter cannot be swapped while the spot is under review', async () => {
    const id = await tenantSpot('tenant-noc-locked');
    await uploadDoc(id);
    await uploadNoc(id);
    await submit(id);

    const res = await uploadNoc(id, { landlord_name: 'Someone Else' });

    expect(res.status).toBe(409);
    expect((await recordFor(id)).landlord_name).toBe('Ramesh Gupta');
  });

  test('an admin sees the letter as a signed URL, like the main document', async () => {
    const id = await tenantSpot('tenant-noc-admin');
    await uploadDoc(id);
    await uploadNoc(id);

    const res = await request(app).get(`/api/v1/spot-verification/admin/${id}`).set(auth(ADMIN));

    expect(res.body.data.submission.landlord_noc_url).toMatch(/^https:\/\/signed\.test\//);
    expect(res.body.data.submission.landlord_name).toBe('Ramesh Gupta');
    expect(res.body.data.submission.relationship).toBe('tenant');
  });
});
