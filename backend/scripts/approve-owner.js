#!/usr/bin/env node
/**
 * approve-owner.js — mark a spot owner as verified, so their spots show up
 * in the finder.
 *
 *   node scripts/approve-owner.js you@example.com            # check only
 *   node scripts/approve-owner.js you@example.com --approve  # check, then approve
 *
 * Why this exists: /spots/nearby only returns a spot when the OWNER is
 * approved (ParkingSpot.findNearby -> "u.verification_status = 'approved'").
 * A new owner starts with verification_status NULL, so their own listings are
 * invisible in the finder even though the spotter dashboard shows them. The
 * normal route is the in-app admin screen; this is for testing with one
 * account, before an ADMIN user exists.
 *
 * It prints the finder's real filters for each spot, so a spot that is still
 * hidden tells you exactly which test it failed.
 *
 * Uses `pg` directly rather than Prisma — one less platform-specific binary
 * to care about.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const email = process.argv[2];
const doApprove = process.argv.includes('--approve');

if (!email || email.startsWith('--')) {
  console.error('Usage: node scripts/approve-owner.js <email> [--approve]');
  process.exit(1);
}

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return null;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    if (line.startsWith('DATABASE_URL=')) {
      return line.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '');
    }
  }
  return null;
}

const yn = (ok) => (ok ? 'yes' : 'NO');

(async () => {
  const url = databaseUrl();
  if (!url) {
    console.error('No DATABASE_URL found (checked the environment and backend/.env).');
    process.exit(1);
  }

  const db = new Client({
    connectionString: url,
    ssl: /\brlwy\.net|railway|amazonaws|supabase/.test(url) ? { rejectUnauthorized: false } : undefined,
  });

  try {
    await db.connect();
  } catch (e) {
    console.error('Could not connect to the database:', e.message);
    process.exit(1);
  }

  try {
    const { rows: users } = await db.query(
      `SELECT id, name, email, role, balance, verification_status
         FROM users WHERE lower(email) = lower($1)`,
      [email],
    );
    if (!users.length) {
      console.error(`No user found with email ${email}`);
      process.exit(1);
    }
    const u = users[0];

    console.log('\nOWNER');
    console.log(`  id                  ${u.id}`);
    console.log(`  name                ${u.name}`);
    console.log(`  email               ${u.email}`);
    console.log(`  role                ${u.role}`);
    console.log(`  balance             ${u.balance}`);
    console.log(`  verification_status ${u.verification_status === null ? 'NULL (never approved)' : u.verification_status}`);

    const { rows: ov } = await db.query(
      `SELECT status FROM owner_verifications WHERE user_id = $1`,
      [u.id],
    );
    console.log(`  owner_verifications ${ov.length ? ov[0].status : 'no row'}`);

    // Every test the finder applies, per spot.
    const { rows: spots } = await db.query(
      `SELECT s.id, s.title, s.is_active, s.latitude, s.longitude,
              COALESCE(s.total_slots, 0) AS total_slots,
              COALESCE(b.taken, 0)::int  AS taken_now
         FROM parking_spots s
         LEFT JOIN (
           SELECT spot_id, COUNT(*)::int AS taken
             FROM bookings
            WHERE status IN ('reserved', 'active', 'checkout_pending')
            GROUP BY spot_id
         ) b ON b.spot_id = s.id
        WHERE s.spotter_id = $1
        ORDER BY s.id`,
      [u.id],
    );

    console.log(`\nSPOTS (${spots.length})`);
    if (!spots.length) console.log('  none listed by this owner');

    for (const s of spots) {
      const free = Math.max(0, Number(s.total_slots) - Number(s.taken_now));
      const hasCoords = s.latitude !== null && s.longitude !== null;
      console.log(`\n  #${s.id}  ${s.title}`);
      console.log(`    is_active = true        ${yn(s.is_active === true)}`);
      console.log(`    owner approved          ${yn(u.verification_status === 'approved')}`);
      console.log(`    balance >= -500         ${yn(Number(u.balance) >= -500)}`);
      console.log(`    free slot (${free} of ${s.total_slots})      ${yn(free > 0)}`);
      console.log(`    has coordinates         ${yn(hasCoords)}${hasCoords ? `  (${s.latitude}, ${s.longitude})` : ''}`);
    }

    if (!doApprove) {
      console.log('\nCheck only. Re-run with --approve to set this owner to approved.\n');
      return;
    }

    console.log('\nAPPROVING…');
    await db.query(`UPDATE users SET verification_status = 'approved' WHERE id = $1`, [u.id]);
    console.log('  users.verification_status -> approved');

    if (ov.length) {
      await db.query(`UPDATE owner_verifications SET status = 'approved' WHERE user_id = $1`, [u.id]);
      console.log('  owner_verifications.status -> approved');
    } else {
      console.log('  owner_verifications: no row, left alone (the finder does not read it)');
    }

    // Prove it by running the finder's own query, from each spot's own
    // position, so distance cannot mask the result.
    console.log('\nVERIFYING with the finder\'s real query (searching from each spot itself):');
    for (const s of spots) {
      if (s.latitude === null || s.longitude === null) {
        console.log(`  #${s.id}  SKIPPED — no coordinates, so it can never be found`);
        continue;
      }
      const { rows: found } = await db.query(
        `SELECT s.id,
                COALESCE(s.total_slots,0) - COALESCE(b.taken,0)::int AS free,
                (6371 * acos(
                   cos(radians($1)) * cos(radians(s.latitude)) *
                   cos(radians(s.longitude) - radians($2)) +
                   sin(radians($1)) * sin(radians(s.latitude))
                )) AS distance
           FROM parking_spots s
           JOIN users uu ON s.spotter_id = uu.id
           LEFT JOIN (
             SELECT spot_id, COUNT(*)::int AS taken FROM bookings
              WHERE status IN ('reserved','active','checkout_pending') GROUP BY spot_id
           ) b ON b.spot_id = s.id
          WHERE s.is_active = true
            AND uu.balance >= -500
            AND uu.verification_status = 'approved'
            AND s.id = $3`,
        [s.latitude, s.longitude, s.id],
      );
      const ok = found.length && Number(found[0].free) > 0;
      console.log(`  #${s.id}  ${ok ? 'VISIBLE in the finder' : 'still hidden — see its checks above'}`);
    }

    console.log('\nDone. Pull down to refresh the finder map, or reopen the app.\n');
  } finally {
    await db.end();
  }
})().catch((e) => {
  console.error('Failed:', e.message);
  process.exit(1);
});
