#!/usr/bin/env node
/**
 * Seed everything needed to walk per-spot verification locally, end to end.
 *
 *   cd backend
 *   node scripts/dev/seed-spot-verification.js
 *   node scripts/dev/seed-spot-verification.js --as admin
 *   node scripts/dev/seed-spot-verification.js --reset
 *
 * WHAT IT CREATES
 *
 *   owner@parkstop.test    SPOTTER, verification_status approved, Aadhaar name
 *                          "Rajesh Kumar" — the PERSON check already passed, so
 *                          anything hidden is hidden because of a SPOT.
 *   admin@parkstop.test    ADMIN. A separate person on purpose: nobody may
 *                          review their own spot, at either stage.
 *   driver@parkstop.test   FINDER, to check what a driver can actually see.
 *
 *   Local test · fresh      not_started, owner-occupied. The happy path:
 *                           upload -> submit -> desk -> field -> live.
 *   Local test · rented     not_started, and the walkthrough makes it a tenant
 *                           so `submit` refuses it until the landlord's letter
 *                           is attached.
 *   Local test · desk done  desk_approved already, so the field check can be
 *                           exercised without repeating the first three steps.
 *   Local test · old spot   grandfathered: visible to drivers, unchecked, and
 *                           deliberately off the 48-hour clock.
 *
 * ── BEFORE THIS IS ANY USE: THE LOCAL BACKEND NEEDS REAL FIREBASE KEYS ────
 *
 * There is no way round this, and it is not a shortcut being withheld. With no
 * service account, config/firebase.js falls back to a mock verifier that
 * returns no `auth_time` — and the OTP session gate (otpSession.js) only
 * accepts tokens whose `auth_time` is recorded against the user. Outside
 * NODE_ENV=test that gate is always on, and NODE_ENV=test stops the server
 * binding a port at all (server.js:234). So every authenticated call to a
 * running local server 401s with OTP_REQUIRED until real keys are present.
 *
 * Put the service account at backend/firebase-service-account.json — already
 * gitignored — or set FIREBASE_SERVICE_ACCOUNT_JSON in backend/.env. Same
 * Firebase project the app already uses, so a real sign-in verifies and the
 * email code works exactly as in production.
 *
 * ── WHICH ACCOUNT THE APP IS ──────────────────────────────────────────────
 *
 * Pass --email with the address you sign into the app with, and this script
 * makes that account the one you need for the half you are testing:
 *
 *   --role owner   your account OWNS the test spots. Walk upload, submit and
 *                  the tenant refusal on the owner screens.
 *   --role admin   your account becomes ADMIN and the spots are moved to the
 *                  seeded owner row, because NOBODY MAY REVIEW THEIR OWN SPOT
 *                  at either stage. Walk the desk review and field check on
 *                  the admin screens.
 *
 * The spots keep their verification state across a swap, so you can do the
 * owner half, re-run with --role admin, and carry straight on. One Google
 * account is enough for the whole walk.
 */
const requireLocalDb = require('../lib/require-local-db');

const target = requireLocalDb({
  script: 'dev/seed-spot-verification.js',
  what: 'create test users and spots, and repoint the local mock sign-in identity',
});

const prisma = require('../../src/config/prisma');

const OWNER = { email: 'owner@parkstop.test', name: 'Rajesh Kumar', phone: '9800000001', role: 'spotter' };
const ADMIN = { email: 'admin@parkstop.test', name: 'ParkStop Admin', phone: '9800000002', role: 'spotter' };
const DRIVER = { email: 'driver@parkstop.test', name: 'Test Driver', phone: '9800000003', role: 'finder' };

/** Koramangala, so the seeded spots sit together and away from real data. */
const PIN = { latitude: 12.93520000, longitude: 77.62450000 };
const ADDRESS = '14 Local Test Road, Koramangala, Bengaluru 560034';

const SPOTS = [
  {
    title: 'Local test · fresh',
    status: 'not_started',
    note: 'The whole walk: upload -> submit -> desk -> field -> live.',
  },
  {
    title: 'Local test · rented',
    status: 'not_started',
    note: 'Upload with "I rent it" to see submit refused until the landlord letter is in.',
  },
  {
    title: 'Local test · desk done',
    status: 'desk_approved',
    note: 'Already past the desk review, so the field check can be tried on its own.',
    verification: {
      submitted_at: new Date(Date.now() - 6 * 3600 * 1000),
      doc_type: 'khata_certificate',
      doc_public_id: 'parkstop/spot-docs/seeded-desk-done',
      doc_sha256: 'seeded'.padEnd(64, '0'),
      doc_format: 'jpg',
      claimed_address: ADDRESS,
      relationship: 'owner',
      name_on_document: 'Rajesh Kumar',
      name_match: 'DIRECT_MATCH',
      name_checked_against: 'aadhaar_name',
      address_match_metres: 40,
      address_match_verdict: 'consistent',
      geocode_precision: 'street',
      geocode_uncertainty_m: 150,
      geocode_source: 'seeded',
      desk_reviewed_at: new Date(Date.now() - 3 * 3600 * 1000),
    },
  },
  {
    title: 'Local test · old spot',
    status: 'grandfathered',
    note: 'Visible to drivers, never checked, and off the 48-hour clock.',
    verification: { grandfathered_at: new Date(Date.now() - 30 * 86400 * 1000) },
  },
];

const arg = (name) => process.argv.includes(name);
const argValue = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

/**
 * Create or update one user, leaving firebase_uid alone.
 *
 * Deliberately NOT setting firebase_uid: a real sign-in links it by verified
 * email on first call (authUserService.resolveUserFromFirebase), and writing
 * a made-up value here would stop that link ever happening.
 */
async function upsertUser({ email, name, phone, role, verified }) {
  const data = {
    name,
    full_name: name,
    phone,
    role,
    verification_status: verified ? 'approved' : null,
  };
  return prisma.users.upsert({
    where: { email },
    update: data,
    create: { email, ...data },
  });
}

async function seedOwnerVerification(userId) {
  // The desk review compares the document against this name, so without it
  // every desk pass would be blocked on "the owner is not verified".
  await prisma.owner_verifications.upsert({
    where: { user_id: userId },
    update: { status: 'approved', aadhaar_name: OWNER.name, aadhaar_verified_at: new Date() },
    create: {
      user_id: userId,
      status: 'approved',
      aadhaar_name: OWNER.name,
      aadhaar_verified_at: new Date(),
      pan_verified_at: new Date(),
      selfie_verified_at: new Date(),
      bank_verified_at: new Date(),
    },
  });
}

async function seedSpot(ownerId, spec) {
  const existing = await prisma.parking_spots.findFirst({
    where: { title: spec.title, spotter_id: ownerId },
  });
  if (existing) {
    await prisma.spot_verifications.deleteMany({ where: { spot_id: existing.id } });
    await prisma.parking_spots.delete({ where: { id: existing.id } });
  }

  const spot = await prisma.parking_spots.create({
    data: {
      spotter_id: ownerId,
      title: spec.title,
      description: spec.note,
      price_per_hour: 40,
      ...PIN,
      address: ADDRESS,
      total_slots: 2,
      available_slots: 2,
      car_slots: 2,
      bike_slots: 0,
      location_type: 'urban',
      is_active: true,
      amenities: [],
      spot_verification_status: spec.status,
      spot_verification: { create: { status: spec.status, ...(spec.verification || {}) } },
    },
  });
  return spot;
}

async function reset() {
  const emails = [OWNER.email, ADMIN.email, DRIVER.email];
  const spots = await prisma.parking_spots.findMany({
    where: { title: { startsWith: 'Local test · ' } },
    select: { id: true },
  });
  const ids = spots.map((s) => s.id);
  if (ids.length) {
    await prisma.bookings.deleteMany({ where: { spot_id: { in: ids } } });
    await prisma.saved_spots.deleteMany({ where: { spot_id: { in: ids } } });
    await prisma.spot_verifications.deleteMany({ where: { spot_id: { in: ids } } });
    await prisma.parking_spots.deleteMany({ where: { id: { in: ids } } });
  }
  const users = await prisma.users.findMany({ where: { email: { in: emails } }, select: { id: true } });
  await prisma.owner_verifications.deleteMany({ where: { user_id: { in: users.map((u) => u.id) } } });
  await prisma.users.deleteMany({ where: { email: { in: emails } } });
  console.log(`Removed ${ids.length} seeded spot(s) and ${users.length} seeded user(s).`);
  console.log('Your own account is left alone — only its role/verification were changed.');
}

(async () => {
  const role = argValue('--role', 'owner').toLowerCase();
  const myEmail = (argValue('--email', '') || '').trim().toLowerCase();

  if (!['owner', 'admin'].includes(role)) {
    console.error(`--role must be "owner" or "admin" (got "${role}")`);
    process.exit(1);
  }

  console.log(`Database: ${target.db} on ${target.host}${target.local ? ' (local)' : ' (NOT LOCAL)'}\n`);

  if (arg('--reset')) {
    await reset();
    await prisma.$disconnect();
    return;
  }

  // The seeded counterparts. Always present, so there is always a second
  // person available — nobody may review their own spot.
  const seededOwner = await upsertUser({ ...OWNER, verified: true });
  const seededAdmin = await upsertUser({ ...ADMIN, role: 'ADMIN', verified: true });
  await upsertUser({ ...DRIVER, verified: false });
  await seedOwnerVerification(seededOwner.id);

  /**
   * Which row owns the spots, and what the tester's own account becomes.
   *
   * For the owner half the tester has to OWN the spots, because the owner
   * screens show their own listings. For the admin half they must NOT, or
   * both decisions are refused as self-review.
   */
  let me = null;
  let spotOwner = seededOwner;
  if (myEmail) {
    me = await upsertUser({
      email: myEmail,
      name: role === 'admin' ? 'ParkStop Admin (you)' : 'Rajesh Kumar',
      phone: '9800000009',
      role: role === 'admin' ? 'ADMIN' : 'spotter',
      verified: true,
    });
    if (role === 'owner') {
      // The desk review needs an Aadhaar name on whoever owns the spot.
      await seedOwnerVerification(me.id);
      spotOwner = me;
    }
  }

  // Spots live under exactly one owner; move any previous seeded ones across
  // so a --role swap keeps their verification state.
  const moved = await prisma.parking_spots.updateMany({
    where: { title: { startsWith: 'Local test · ' }, spotter_id: { not: spotOwner.id } },
    data: { spotter_id: spotOwner.id },
  });

  const made = [];
  for (const spec of SPOTS) {
    const existing = await prisma.parking_spots.findFirst({
      where: { title: spec.title, spotter_id: spotOwner.id },
    });
    made.push({ spec, spot: existing || await seedSpot(spotOwner.id, spec) });
  }

  const PORT = process.env.PORT || 3000;
  console.log('WHO IS WHO');
  console.log(`  spots owned by   ${spotOwner.email}  (id ${spotOwner.id})`);
  if (me) {
    console.log(`  your app account ${me.email}  ->  ${role === 'admin' ? 'ADMIN' : 'SPOTTER, owns the spots'}`);
  } else {
    console.log('  your app account NOT SET — pass --email <the address you sign in with>');
    console.log('                   so the app resolves you to a seeded role.');
  }
  console.log(`  the other side   ${role === 'admin' ? seededOwner.email + ' (owner)' : seededAdmin.email + ' (admin)'}`);
  if (moved.count) console.log(`  (moved ${moved.count} existing seeded spot(s) to the new owner)`);
  console.log('');

  console.log(`YOU ARE SET UP FOR THE ${role.toUpperCase()} HALF`);
  if (role === 'owner') {
    console.log('  In the app: Spots tab -> tap a spot\'s verification badge.');
    console.log('    "Local test · fresh"   upload -> submit -> watch it leave the finder');
    console.log('    "Local test · rented"  upload with "I rent it" -> submit is refused');
    console.log(`  Then: node scripts/dev/seed-spot-verification.js --email ${myEmail || '<you>'} --role admin`);
  } else {
    console.log('  In the app: Admin home -> "Spot verifications".');
    console.log('    Desk queue   read the document, type the name, pass or send back');
    console.log('    Field queue  record the office and reference -> the spot goes live');
    console.log(`  Then: node scripts/dev/seed-spot-verification.js --email ${myEmail || '<you>'} --role owner`);
  }
  console.log('');

  console.log('SPOTS');
  for (const { spec, spot } of made) {
    console.log(`  #${String(spot.id).padEnd(6)} ${spec.title.padEnd(24)} ${spec.status}`);
    console.log(`          ${spec.note}`);
  }
  console.log('');
  console.log(`Backend should be at http://localhost:${PORT}/api/v1 with SPOT_VERIFICATION_GATE=on.`);
  console.log('Re-run any time. --reset removes the seeded users and spots.');

  await prisma.$disconnect();
})().catch(async (err) => {
  console.error('\nSeed failed:', err.message);
  await prisma.$disconnect();
  process.exit(1);
});
