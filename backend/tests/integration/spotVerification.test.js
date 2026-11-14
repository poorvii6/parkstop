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
      .field('doc_type', fields.doc_type ?? 'electricity_bill')
      .field('address', fields.address ?? '42 Verification Road, Indiranagar, Bengaluru 560038');
    if (fields.relationship) req.field('relationship', fields.relationship);
    return req.attach('document', Buffer.from('not-really-a-jpeg'), 'bill.jpg');
  };

  test('a document moves the spot to in_progress', async () => {
    const res = await upload(OWNER, ids.spots.unverified);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('in_progress');
    expect(res.body.data.is_live).toBe(false);

    const record = await recordFor(ids.spots.unverified);
    expect(record.doc_type).toBe('electricity_bill');
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
    // Nothing has passed a desk review yet — stage 2 does that.
    expect(field.body.data.items).toHaveLength(0);
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
