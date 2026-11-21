/**
 * THIS FILE TESTS THE GATE **ON**.
 *
 * Per-spot verification ships behind SPOT_VERIFICATION_GATE and defaults to
 * OFF, so every assertion here about a spot being hidden, a pin being frozen
 * or a promise being made has to say which world it is in. Set before the
 * constants module is required, because that is where the flag is read.
 *
 * The OFF path has its own coverage — tests/unit/spotGate.test.js and the
 * gate-off block in tests/integration/spotVerificationHardening.test.js —
 * because off is what is about to be in production.
 */
process.env.SPOT_VERIFICATION_GATE = 'on';

/**
 * The field-check controller's OWN guards, called directly.
 *
 * Over HTTP these are shadowed: the route validators reject a missing office
 * and a non-boolean record_found before the handler runs, so an integration
 * test cannot tell whether the controller still checks. Mutation testing found
 * exactly that — deleting either guard broke nothing.
 *
 * They are kept, and tested here, because the controller is the authority and
 * is reachable without the route: a future internal job, a script, or stage 4.
 * The coercion case is the one that matters most — `record_found: 'false'` is
 * a TRUTHY string, so without the type check a "we found nothing" result would
 * publish the spot.
 *
 * Prisma, Cloudinary and notifications are mocked; this runs with no database.
 *
 *   npx jest tests/unit/spotVerificationController.guards.test.js
 */
jest.mock('../../src/config/prisma', () => ({
  spot_verifications: {
    findUnique: jest.fn(), update: jest.fn(), create: jest.fn(), count: jest.fn(),
    // The field pass looks for the same registration reference on another
    // spot. Default to "nowhere else"; the duplicate case sets its own.
    findMany: jest.fn().mockResolvedValue([]),
  },
  parking_spots: { findUnique: jest.fn(), update: jest.fn() },
  users: { findMany: jest.fn().mockResolvedValue([]) },
  $transaction: jest.fn(),
}));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../../src/services/notificationService', () => ({
  sendPushNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('cloudinary', () => ({
  v2: { config: jest.fn(), url: (id) => `https://signed.test/${id}`, uploader: { upload_stream: jest.fn(), destroy: jest.fn() } },
}));

const prisma = require('../../src/config/prisma');
const C = require('../../src/controllers/spotVerificationController');

/** A spot that has passed its desk review and is waiting for the field check. */
const deskApprovedRecord = (over = {}) => ({
  id: 7,
  spot_id: 1,
  status: 'desk_approved',
  claimed_address: '42 Verification Road, Indiranagar, Bengaluru 560038',
  desk_reviewed_at: new Date('2026-11-14T09:00:00Z'),
  desk_reviewed_by: 9,
  review_log: [],
  parking_spots: {
    id: 1,
    title: 'Front driveway',
    latitude: 12.97,
    longitude: 77.59,
    users: { id: 5, verification_status: 'approved', owner_verification: { aadhaar_name: 'Rajesh Kumar' } },
  },
  ...over,
});

const res = () => {
  const r = { statusCode: 200, body: null };
  r.status = jest.fn((code) => { r.statusCode = code; return r; });
  r.json = jest.fn((body) => { r.body = body; return r; });
  return r;
};

const req = (body) => ({ params: { spotId: '1' }, body, user: { id: 9, role: 'ADMIN' } });

/** What saveAndSync would have written, if it was called at all. */
let written;

beforeEach(() => {
  jest.clearAllMocks();
  written = null;
  prisma.spot_verifications.findUnique.mockResolvedValue(deskApprovedRecord());
  prisma.$transaction.mockImplementation(async (fn) => fn({
    spot_verifications: {
      update: jest.fn(async ({ data }) => {
        written = data;
        return { ...deskApprovedRecord(), ...data, spot_id: 1 };
      }),
    },
    parking_spots: { update: jest.fn() },
  }));
});

describe('the field check refuses what the route would have caught', () => {
  test('no office: nothing is recorded', async () => {
    const r = res();

    await C.adminFieldDecision(req({ record_found: true, reference: 'SRO/1/2019' }), r);

    expect(r.statusCode).toBe(400);
    expect(r.body.message).toMatch(/Record which office was checked/);
    expect(written).toBeNull();
  });

  test('an office of two characters is not an office', async () => {
    const r = res();

    await C.adminFieldDecision(req({ office: 'SR', record_found: true, reference: 'SRO/1/2019' }), r);

    expect(r.statusCode).toBe(400);
    expect(written).toBeNull();
  });

  test('a string instead of a boolean is refused, not coerced', async () => {
    const r = res();

    await C.adminFieldDecision(req({ office: 'SRO Indiranagar', record_found: 'true', reference: 'SRO/1' }), r);

    expect(r.statusCode).toBe(400);
    expect(r.body.message).toMatch(/record_found must be true or false/);
    expect(written).toBeNull();
  });

  /**
   * The case this guard exists for. 'false' is a non-empty string and so
   * TRUTHY: without the type check, a field team reporting that they found
   * nothing would publish the spot.
   */
  test("the string 'false' never publishes a spot", async () => {
    const r = res();

    await C.adminFieldDecision(req({ office: 'SRO Indiranagar', record_found: 'false' }), r);

    expect(r.statusCode).toBe(400);
    expect(written).toBeNull();
  });

  test('a missing answer is not read as either answer', async () => {
    for (const record_found of [undefined, null, 0, 1, '']) {
      const r = res();
      // eslint-disable-next-line no-await-in-loop
      await C.adminFieldDecision(req({ office: 'SRO Indiranagar', record_found, reference: 'SRO/1' }), r);

      expect(r.statusCode).toBe(400);
      expect(written).toBeNull();
    }
  });

  test('a real boolean gets through, so the guards are not simply refusing everything', async () => {
    const r = res();

    await C.adminFieldDecision(
      req({ office: 'Sub-Registrar Office, Indiranagar', record_found: true, reference: 'SRO/IND/2019/4471' }),
      r
    );

    expect(r.statusCode).toBe(200);
    expect(written.status).toBe('approved');
    expect(written.field_record_found).toBe(true);
  });

  test('a desk review that never happened cannot publish, whatever the status says', async () => {
    prisma.spot_verifications.findUnique.mockResolvedValue(
      deskApprovedRecord({ desk_reviewed_at: null, desk_reviewed_by: null })
    );
    const r = res();

    await C.adminFieldDecision(
      req({ office: 'Sub-Registrar Office, Indiranagar', record_found: true, reference: 'SRO/IND/2019/4471' }),
      r
    );

    expect(r.statusCode).toBe(409);
    expect(r.body.message).toMatch(/has not passed both checks/);
    expect(written).toBeNull();
  });

  test('an owner cannot be their own field checker', async () => {
    // req() is admin id 9; make the spot's owner the same person.
    prisma.spot_verifications.findUnique.mockResolvedValue(deskApprovedRecord({
      parking_spots: {
        ...deskApprovedRecord().parking_spots,
        users: { id: 9, verification_status: 'approved', owner_verification: { aadhaar_name: 'Rajesh Kumar' } },
      },
    }));
    const r = res();

    await C.adminFieldDecision(
      req({ office: 'Sub-Registrar Office, Indiranagar', record_found: true, reference: 'SRO/IND/2019/4471' }),
      r
    );

    expect(r.statusCode).toBe(403);
    expect(r.body.message).toMatch(/belongs to you/);
    expect(written).toBeNull();
  });

  test('a registration reference already used at another address cannot publish', async () => {
    // The duplicate check that does not depend on the file's bytes: re-download
    // a PDF and doc_sha256 changes, but the registrar's reference does not.
    prisma.spot_verifications.findMany.mockResolvedValue([
      {
        spot_id: 42,
        claimed_address: '9 Somewhere Else Lane, Koramangala, Bengaluru 560034',
        status: 'approved',
        parking_spots: { title: 'A different driveway' },
      },
    ]);
    const r = res();

    await C.adminFieldDecision(
      req({ office: 'Sub-Registrar Office, Indiranagar', record_found: true, reference: 'SRO/IND/2019/4471' }),
      r
    );

    expect(r.statusCode).toBe(409);
    expect(r.body.code).toBe('FIELD_REFERENCE_ALREADY_USED');
    expect(r.body.also_used_for[0].spot_id).toBe(42);
    expect(written).toBeNull();
  });

  test('the same reference at the same address still publishes', async () => {
    // One plot, several bays, all verified against the one property record.
    prisma.spot_verifications.findMany.mockResolvedValue([
      {
        spot_id: 42,
        claimed_address: '42 Verification Road, Indiranagar, Bengaluru 560038',
        status: 'approved',
        parking_spots: { title: 'The next bay along' },
      },
    ]);
    const r = res();

    await C.adminFieldDecision(
      req({ office: 'Sub-Registrar Office, Indiranagar', record_found: true, reference: 'SRO/IND/2019/4471' }),
      r
    );

    expect(r.statusCode).toBe(200);
    expect(written.status).toBe('approved');
  });
});
