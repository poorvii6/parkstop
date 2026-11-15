/**
 * Per-spot verification: can a determined owner get a spot verified without
 * actually holding it?
 *
 * Stages 1-3 built the gate, the clock, the two checks and the field visit.
 * This file is the adversarial pass over them — it does not test that the
 * happy path works (spotVerification.test.js does that), it tests the ways
 * round it. Every case here was a real hole on 15 Nov 2026, proven before it
 * was fixed, and is kept so it cannot reopen.
 *
 * The four:
 *
 *   1. ONE DOCUMENT, MANY SPOTS. One genuine khata verified four unrelated
 *      driveways. The name matched (same person), the address check could not
 *      object because a Bengaluru address geocodes to a locality and a
 *      locality hit is UNVERIFIABLE which does not block, and the field check
 *      found the record because the record was real. Nothing looked at whether
 *      the same piece of paper had already been spent.
 *
 *   2. A TENANT'S DOCUMENT COMPARED TO THE WRONG PERSON. A tenant submits
 *      their LANDLORD's ownership document, which is what we ask for. It was
 *      compared to the TENANT's Aadhaar name, so every correct tenant
 *      submission came out NO_MATCH and demanded an override. Training an
 *      admin to click through NAME_NO_MATCH is how a forged OWNER submission
 *      gets waved through.
 *
 *   3. SELF-APPROVAL. An admin who is also a spotter could upload a document
 *      to their own driveway and pass both of their own reviews.
 *
 *   4. HALF A NAME. "Suresh Kumar" against a verified "Rajesh Kumar" came out
 *      MODERATE_PARTIAL_MATCH, which does not block. Covered in
 *      spotVerification.test.js and nameMatch.test.js; the conflict rule is
 *      exercised here through the tenant cases.
 *
 * Plus the thing the whole feature is for: FOUR DRIVEWAYS MEANS FOUR CHECKS.
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

// Nothing leaves the test. A fresh public_id each time, exactly as Cloudinary
// behaves — which is itself the reason doc_sha256 has to exist: two uploads of
// one file never share an id, so the id can never reveal reuse.
jest.mock('cloudinary', () => {
  let n = 0;
  return {
    v2: {
      config: jest.fn(),
      url: (publicId) => `https://signed.test/${publicId}`,
      uploader: {
        upload_stream: (opts, cb) => ({
          end: () => cb(null, { public_id: `parkstop/spot-docs/hard-${++n}` }),
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
const { geocodeAddress } = require('../../src/services/geocoding');
const { PRECISION } = require('../../src/services/geocoding');

const OWNER = { uid: 'hardowner', email: 'hardowner@gmail.com', phone: '9876410001' };
const ADMIN = { uid: 'hardadmin', email: 'hardadmin@gmail.com', phone: '9876410002' };
/** An admin who also lists spots. The self-approval case. */
const ADMIN_OWNER = { uid: 'hardadminowner', email: 'hardadminowner@gmail.com', phone: '9876410003' };

const token = (who) => `mock-firebase-token-${who.uid}`;
const auth = (who) => ({ Authorization: `Bearer ${token(who)}` });

const PIN = { latitude: 12.96011122, longitude: 77.56022233 };
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
      address: '1 Hardening St',
      total_slots: 2, available_slots: 2, car_slots: 2, bike_slots: 0,
      location_type: 'urban', is_active: true, amenities: [],
      spot_verification_status: status,
      spot_verification: { create: { status } },
    },
  });
  ids.spots[title] = spot.id;
  return spot.id;
}

const recordFor = (spotId) => prisma.spot_verifications.findUnique({ where: { spot_id: spotId } });
const spotRow = (spotId) => prisma.parking_spots.findUnique({ where: { id: spotId } });

/** The geocoder lands this many metres north of the pin. */
const resolvesTo = ({ metresNorth = 10, precision = PRECISION.STREET, uncertainty = 150 } = {}) => {
  geocodeAddress.mockResolvedValue({
    lat: String(PIN.latitude + metresNorth / 110540),
    lon: String(PIN.longitude),
    precision,
    uncertainty_m: uncertainty,
    source: 'nominatim',
    display_name: 'Somewhere, Bengaluru',
    bbox: null,
    place_rank: 26,
    kind: 'highway/residential',
  });
};

const ADDRESS_A = '42 Hardening Road, Indiranagar, Bengaluru 560038';
const ADDRESS_B = '9 Elsewhere Lane, Koramangala, Bengaluru 560034';

/** Upload a document. `file` is the bytes, so two calls can share one file. */
function uploadDoc(who, spotId, { file, address = ADDRESS_A, docType = 'khata_certificate', relationship = 'owner' } = {}) {
  return request(app)
    .post(`/api/v1/spot-verification/${spotId}/document`)
    .set(auth(who))
    .field('doc_type', docType)
    .field('address', address)
    .field('relationship', relationship)
    .attach('document', Buffer.from(file), 'doc.jpg');
}

function uploadNoc(who, spotId, { file, landlordName = 'Ramesh Gupta' } = {}) {
  return request(app)
    .post(`/api/v1/spot-verification/${spotId}/landlord-noc`)
    .set(auth(who))
    .field('landlord_name', landlordName)
    .attach('document', Buffer.from(file), 'noc.jpg');
}

const submit = (who, spotId) =>
  request(app).post(`/api/v1/spot-verification/${spotId}/submit`).set(auth(who));
const desk = (who, spotId, body) =>
  request(app).post(`/api/v1/spot-verification/admin/${spotId}/desk`).set(auth(who)).send(body);
const field = (who, spotId, body) =>
  request(app).post(`/api/v1/spot-verification/admin/${spotId}/field`).set(auth(who)).send(body);
const detail = (who, spotId) =>
  request(app).get(`/api/v1/spot-verification/admin/${spotId}`).set(auth(who));
const mine = (who, spotId) =>
  request(app).get(`/api/v1/spot-verification/${spotId}`).set(auth(who));

beforeAll(async () => {
  const owner = await register(OWNER, 'spotter');
  const admin = await register(ADMIN, 'spotter');
  const adminOwner = await register(ADMIN_OWNER, 'spotter');

  await prisma.users.update({ where: { id: owner.id }, data: { verification_status: 'approved' } });
  await prisma.users.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });
  await prisma.users.update({
    where: { id: adminOwner.id },
    data: { role: 'ADMIN', verification_status: 'approved' },
  });

  ids.owner = owner.id;
  ids.admin = admin.id;
  ids.adminOwner = adminOwner.id;

  // The desk review compares the document against a verified name.
  await prisma.owner_verifications.createMany({
    data: [
      { user_id: owner.id, status: 'approved', aadhaar_name: 'Rajesh Kumar' },
      { user_id: adminOwner.id, status: 'approved', aadhaar_name: 'Admin Owner' },
    ],
    skipDuplicates: true,
  });
});

afterAll(async () => {
  const spotIds = Object.values(ids.spots);
  await prisma.spot_verifications.deleteMany({ where: { spot_id: { in: spotIds } } });
  await prisma.parking_spots.deleteMany({ where: { id: { in: spotIds } } });
  await prisma.owner_verifications.deleteMany({
    where: { user_id: { in: [ids.owner, ids.adminOwner] } },
  });
  await prisma.users.deleteMany({
    where: { email: { in: [OWNER.email, ADMIN.email, ADMIN_OWNER.email] } },
  });
  await prisma.$disconnect();
});

beforeEach(() => {
  jest.clearAllMocks();
  resolvesTo();
});

// ───────────────── four driveways means four checks ─────────────────

/**
 * The reason per-spot verification exists.
 *
 * Owner verification approves a PERSON. It used to also collect one property
 * document for the whole account, which an owner with four driveways satisfied
 * with one piece of paper naming at most one of them. That step is gone. Each
 * spot now carries its own document, its own measurement and its own verdict.
 */
describe('one owner, four driveways, four separate verifications', () => {
  const titles = ['four-a', 'four-b', 'four-c', 'four-d'];
  let spotIds = [];

  beforeAll(async () => {
    spotIds = [];
    for (const t of titles) spotIds.push(await makeSpot(ids.owner, t));
  });

  test('all four start invisible, each with its own record', async () => {
    const records = await Promise.all(spotIds.map(recordFor));

    expect(records).toHaveLength(4);
    expect(records.map((r) => r.status)).toEqual(['not_started', 'not_started', 'not_started', 'not_started']);
    // Four rows, four distinct ids: the record is per spot, not per owner.
    expect(new Set(records.map((r) => r.id)).size).toBe(4);
    for (const r of records) expect(r.doc_public_id).toBeNull();
  });

  test('verifying one does not touch the other three', async () => {
    const [a, ...rest] = spotIds;

    await uploadDoc(OWNER, a, { file: 'khata-for-four-a' });
    await submit(OWNER, a);
    await desk(ADMIN, a, { decision: 'pass', name_on_document: 'Rajesh Kumar' });
    await field(ADMIN, a, { office: 'SRO Indiranagar', record_found: true, reference: 'SRO/4A/2026' });

    expect((await recordFor(a)).status).toBe('approved');
    expect((await spotRow(a)).spot_verification_status).toBe('approved');

    // The other three are exactly where they were. An approved OWNER is not an
    // approved PLACE, and three of these places have never been looked at.
    for (const other of rest) {
      expect((await recordFor(other)).status).toBe('not_started');
      expect((await spotRow(other)).spot_verification_status).toBe('not_started');
    }
  });

  test('each of the remaining three must be submitted on its own', async () => {
    for (const id of spotIds.slice(1)) {
      const res = await submit(OWNER, id);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Add a document for this address/);
    }
  });
});

// ───────────── one document cannot cover another address ─────────────

describe('the same document cannot verify a different address', () => {
  test('reusing the exact file for another address is refused', async () => {
    const a = await makeSpot(ids.owner, 'reuse-a');
    const b = await makeSpot(ids.owner, 'reuse-b');
    const theKhata = 'one-genuine-khata-bytes';

    expect((await uploadDoc(OWNER, a, { file: theKhata, address: ADDRESS_A })).status).toBe(200);

    const res = await uploadDoc(OWNER, b, { file: theKhata, address: ADDRESS_B });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already being used for a different address/);
    expect(res.body.also_used_for).toEqual([{ spot_id: a, address: ADDRESS_A }]);
    // Nothing was written for the second spot.
    expect((await recordFor(b)).doc_public_id).toBeNull();
    expect((await recordFor(b)).status).toBe('not_started');
  });

  test('the SAME address is allowed — four bays on one property is one property', async () => {
    const a = await makeSpot(ids.owner, 'bays-a');
    const b = await makeSpot(ids.owner, 'bays-b');
    const theKhata = 'khata-for-a-four-bay-plot';

    expect((await uploadDoc(OWNER, a, { file: theKhata, address: ADDRESS_A })).status).toBe(200);
    const res = await uploadDoc(OWNER, b, { file: theKhata, address: ADDRESS_A });

    expect(res.status).toBe(200);
    expect((await recordFor(b)).doc_sha256).toBe((await recordFor(a)).doc_sha256);
  });

  test('a different spelling of the address is treated as a different address', async () => {
    // The comparison is deliberately crude and fails towards asking a human.
    // Saying "same" wrongly lets a document cover a second address silently;
    // saying "different" wrongly costs the owner one re-upload.
    const a = await makeSpot(ids.owner, 'spelling-a');
    const b = await makeSpot(ids.owner, 'spelling-b');
    const doc = 'khata-spelling';

    await uploadDoc(OWNER, a, { file: doc, address: '42 Hardening Road, Indiranagar, Bengaluru 560038' });
    const res = await uploadDoc(OWNER, b, { file: doc, address: '42 Hardening Rd, Indiranagar, Bengaluru 560038' });

    expect(res.status).toBe(409);
  });

  test('punctuation and case alone do not make it a different address', async () => {
    const a = await makeSpot(ids.owner, 'punct-a');
    const b = await makeSpot(ids.owner, 'punct-b');
    const doc = 'khata-punct';

    await uploadDoc(OWNER, a, { file: doc, address: '42 Hardening Road, Indiranagar, Bengaluru 560038' });
    const res = await uploadDoc(OWNER, b, { file: doc, address: '42  hardening road -- indiranagar, BENGALURU 560038' });

    expect(res.status).toBe(200);
  });

  test('replacing a spot\'s own document with the same file is fine', async () => {
    const a = await makeSpot(ids.owner, 'replace-same');
    const doc = 'khata-replace';

    expect((await uploadDoc(OWNER, a, { file: doc })).status).toBe(200);
    expect((await uploadDoc(OWNER, a, { file: doc })).status).toBe(200);
  });

  test('an admin is shown every other spot holding the same file', async () => {
    const a = await makeSpot(ids.owner, 'shown-a');
    const b = await makeSpot(ids.owner, 'shown-b');
    const doc = 'khata-shown';

    await uploadDoc(OWNER, a, { file: doc, address: ADDRESS_A });
    await uploadDoc(OWNER, b, { file: doc, address: ADDRESS_A });

    const res = await detail(ADMIN, a);

    expect(res.status).toBe(200);
    expect(res.body.data.submission.same_document_on).toEqual([
      expect.objectContaining({ spot_id: b, same_owner: true, same_address: true }),
    ]);
  });

  test('a landlord letter cannot be reused for another address either', async () => {
    const a = await makeSpot(ids.owner, 'noc-reuse-a');
    const b = await makeSpot(ids.owner, 'noc-reuse-b');
    const letter = 'one-consent-letter';

    await uploadDoc(OWNER, a, { file: 'rent-a', address: ADDRESS_A, docType: 'rent_agreement', relationship: 'tenant' });
    expect((await uploadNoc(OWNER, a, { file: letter })).status).toBe(200);

    await uploadDoc(OWNER, b, { file: 'rent-b', address: ADDRESS_B, docType: 'rent_agreement', relationship: 'tenant' });
    const res = await uploadNoc(OWNER, b, { file: letter });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already being used for a different address/);
  });
});

// ──────────────────── nobody verifies their own spot ────────────────────

describe('an admin cannot verify their own spot', () => {
  let own;

  beforeAll(async () => {
    own = await makeSpot(ids.adminOwner, 'admin-own-spot');
    await uploadDoc(ADMIN_OWNER, own, { file: 'admin-own-khata' });
    await submit(ADMIN_OWNER, own);
  });

  test('they can submit it like anyone else', async () => {
    expect((await recordFor(own)).status).toBe('desk_pending');
  });

  test('their own desk review is refused', async () => {
    const res = await desk(ADMIN_OWNER, own, { decision: 'pass', name_on_document: 'Admin Owner' });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/belongs to you/);
    expect((await recordFor(own)).status).toBe('desk_pending');
  });

  test('they cannot reject it either — no decision at all', async () => {
    const res = await desk(ADMIN_OWNER, own, {
      decision: 'reject',
      reason: 'Rejecting my own spot to see what happens.',
    });

    expect(res.status).toBe(403);
    expect((await recordFor(own)).status).toBe('desk_pending');
  });

  test('their own field check is refused, which is the one that goes live', async () => {
    // Pass the desk stage with a DIFFERENT admin, so the only thing left
    // standing between this spot and the finder is the field check.
    await desk(ADMIN, own, { decision: 'pass', name_on_document: 'Admin Owner' });
    expect((await recordFor(own)).status).toBe('desk_approved');

    const res = await field(ADMIN_OWNER, own, {
      office: 'SRO Indiranagar', record_found: true, reference: 'SRO/SELF/2026',
    });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/belongs to you/);
    expect((await recordFor(own)).status).toBe('desk_approved');
    expect((await spotRow(own)).spot_verification_status).not.toBe('approved');
  });

  test('another admin can verify it, so nothing is deadlocked', async () => {
    const res = await field(ADMIN, own, {
      office: 'SRO Indiranagar', record_found: true, reference: 'SRO/OTHER/2026',
    });

    expect(res.status).toBe(200);
    expect((await recordFor(own)).status).toBe('approved');
  });

  test('the record shows who looked, and whether it was one person', async () => {
    const res = await detail(ADMIN, own);

    expect(res.body.data.independence).toMatchObject({
      desk_reviewed_by: ids.admin,
      field_checked_by: ids.admin,
      both_stages_same_admin: true,
      reviewer_is_the_owner: false,
    });
  });
});

// ─────────────── a tenant is checked against the landlord ───────────────

describe('a tenant\'s document is checked against the landlord, not the tenant', () => {
  /** A rented spot, submitted correctly: landlord's khata plus the letter. */
  async function tenantSpot(title, { nameOnKhata = 'Ramesh Gupta', landlordName = 'Ramesh Gupta' } = {}) {
    const id = await makeSpot(ids.owner, title);
    await uploadDoc(OWNER, id, {
      file: `tenant-doc-${title}`, address: ADDRESS_A,
      docType: 'khata_certificate', relationship: 'tenant',
    });
    await uploadNoc(OWNER, id, { file: `tenant-noc-${title}`, landlordName });
    await submit(OWNER, id);
    return { id, nameOnKhata };
  }

  test('the landlord\'s khata passes WITHOUT an override', async () => {
    // The whole point. This is a correct tenant submission — the ownership
    // document names the landlord, because the landlord owns the place. It
    // used to raise NAME_NO_MATCH against the tenant's Aadhaar name and demand
    // an override every single time.
    const { id } = await tenantSpot('tenant-correct');

    const res = await desk(ADMIN, id, {
      decision: 'pass',
      name_on_document: 'Ramesh Gupta',
      noc_names_owner: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.name.checked_against).toBe('landlord_name');
    expect(res.body.data.name.verdict).toBe('DIRECT_MATCH');
    expect(res.body.data.overridden).toEqual([]);

    const record = await recordFor(id);
    expect(record.status).toBe('desk_approved');
    expect(record.name_checked_against).toBe('landlord_name');
    expect(record.noc_names_owner).toBe(true);
    expect(record.desk_override_reason).toBeNull();
  });

  test('a document naming neither the landlord nor anyone else is blocked', async () => {
    const { id } = await tenantSpot('tenant-wrong-name');

    const res = await desk(ADMIN, id, {
      decision: 'pass',
      name_on_document: 'Mohan Lal',
      noc_names_owner: true,
    });

    expect(res.status).toBe(409);
    expect(res.body.blockers.map((b) => b.code)).toContain('LANDLORD_NAME_NO_MATCH');
    expect((await recordFor(id)).status).toBe('desk_pending');
  });

  test('the tenant\'s own name on the ownership document is blocked', async () => {
    // A tenant whose "landlord's khata" is in their own name is either
    // confused or submitting something they made. Either way a human looks.
    const { id } = await tenantSpot('tenant-own-name');

    const res = await desk(ADMIN, id, {
      decision: 'pass',
      name_on_document: 'Rajesh Kumar',
      noc_names_owner: true,
    });

    expect(res.status).toBe(409);
    expect(res.body.blockers.map((b) => b.code)).toContain('LANDLORD_NAME_NO_MATCH');
  });

  test('a desk pass needs the admin to confirm the letter names this owner', async () => {
    const { id } = await tenantSpot('tenant-no-confirm');

    const res = await desk(ADMIN, id, { decision: 'pass', name_on_document: 'Ramesh Gupta' });

    expect(res.status).toBe(409);
    expect(res.body.blockers.map((b) => b.code)).toContain('NOC_DOES_NOT_NAME_OWNER');
    expect(res.body.cannot_be_overridden).toContain('NOC_DOES_NOT_NAME_OWNER');
    expect((await recordFor(id)).status).toBe('desk_pending');
  });

  test('that confirmation cannot be overridden — it is a fact, not a judgement', async () => {
    const { id } = await tenantSpot('tenant-override-attempt');

    const res = await desk(ADMIN, id, {
      decision: 'pass',
      name_on_document: 'Ramesh Gupta',
      override_reason: 'Letter looks fine to me, waving this one through for now.',
    });

    expect(res.status).toBe(409);
    expect(res.body.cannot_be_overridden).toContain('NOC_DOES_NOT_NAME_OWNER');
    expect((await recordFor(id)).status).toBe('desk_pending');
  });

  test('a letter that does NOT name the owner cannot pass at all', async () => {
    // The hole this closes: a genuine khata from the landlord plus a consent
    // letter written for somebody else — a previous tenant, say. Both real
    // documents, and nothing used to ask whose name was on the letter.
    const { id } = await tenantSpot('tenant-noc-other-person');

    const res = await desk(ADMIN, id, {
      decision: 'pass',
      name_on_document: 'Ramesh Gupta',
      noc_names_owner: false,
      override_reason: 'Not this owner but I will allow it anyway, long-standing user.',
    });

    expect(res.status).toBe(409);
    expect(res.body.blockers.map((b) => b.code)).toContain('NOC_DOES_NOT_NAME_OWNER');
    expect((await recordFor(id)).status).toBe('desk_pending');
  });

  test('replacing the letter clears the confirmation', async () => {
    const { id } = await tenantSpot('tenant-noc-replaced');
    await desk(ADMIN, id, { decision: 'pass', name_on_document: 'Ramesh Gupta', noc_names_owner: true });
    expect((await recordFor(id)).noc_names_owner).toBe(true);

    // Send it back so the owner may edit, then swap the letter.
    await prisma.spot_verifications.update({ where: { spot_id: id }, data: { status: 'rejected' } });
    await uploadNoc(OWNER, id, { file: 'a-different-letter', landlordName: 'Ramesh Gupta' });

    // A new letter is a letter nobody has read.
    expect((await recordFor(id)).noc_names_owner).toBeNull();
  });

  test('an owner-occupied spot is unaffected: still checked against Aadhaar', async () => {
    const id = await makeSpot(ids.owner, 'owner-occupied-unaffected');
    await uploadDoc(OWNER, id, { file: 'owner-khata', address: ADDRESS_A, relationship: 'owner' });
    await submit(OWNER, id);

    const res = await desk(ADMIN, id, { decision: 'pass', name_on_document: 'Rajesh Kumar' });

    expect(res.status).toBe(200);
    expect(res.body.data.name.checked_against).toBe('aadhaar_name');
    expect((await recordFor(id)).noc_names_owner).toBeNull();
  });
});

// ───────────── what the owner is allowed to see about all this ─────────────

describe('none of the internal detail reaches the owner', () => {
  test('field notes, reviewer ids and document hashes all stay inside', async () => {
    const id = await makeSpot(ids.owner, 'owner-sees-nothing');
    await uploadDoc(OWNER, id, { file: 'privacy-khata', address: ADDRESS_A });
    await submit(OWNER, id);
    await desk(ADMIN, id, { decision: 'pass', name_on_document: 'Rajesh Kumar' });
    await field(ADMIN, id, {
      office: 'SRO Indiranagar',
      record_found: false,
      notes: 'Clerk suspects the document is fabricated; flagged internally.',
      reason: 'We could not find a property record for this address.',
    });

    const res = await mine(OWNER, id);
    const body = JSON.stringify(res.body);

    expect(res.status).toBe(200);
    expect(res.body.data.rejection_reason).toMatch(/could not find a property record/);
    // The note an admin wrote for other admins.
    expect(body).not.toMatch(/fabricated|flagged internally/);
    // The office, the reference and who looked.
    expect(body).not.toMatch(/SRO Indiranagar/);
    expect(body).not.toMatch(/field_notes|field_office|checked_by|reviewed_by/);
    // The document's identifiers.
    expect(body).not.toMatch(/doc_sha256|doc_public_id|parkstop\/spot-docs/);
    expect(body).not.toMatch(/independence|same_document_on/);
  });
});
