#!/usr/bin/env node
/**
 * make-admin.js — give an existing user the ADMIN role.
 *
 *   node scripts/make-admin.js someone@example.com             # check only
 *   node scripts/make-admin.js someone@example.com --confirm   # set role ADMIN
 *
 * Why this exists: there is no way to create an admin. Not through the app,
 * not through a script, and the role column defaults to FINDER. That matters
 * beyond permissions, because the weekly payout run refuses to start without
 * one (weeklyPayoutService: "Weekly payout run ABORTED: no ADMIN account
 * exists"). It moves balances out of owners' wallets into 'requested' rows
 * that only an ADMIN can pay or return, so with no admin it does nothing at
 * all rather than stranding everyone's money. Correct, but it means owners
 * are never paid until an admin exists.
 *
 * It does NOT create users. The row is created by Firebase sign-in, which is
 * what links firebase_uid and proves the email; inventing a row here would
 * make one that could never be signed into. So the person signs in to the app
 * once, then this changes their role.
 *
 * Uses `pg` directly rather than Prisma — one less platform-specific binary
 * to care about, same as approve-owner.js.
 */
// Refuse to run against a non-local database unless --production is passed.
// This script writes.
const requireLocalDb = require('./lib/require-local-db');
requireLocalDb({ script: 'make-admin.js', what: "set a user's role to ADMIN" });

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const email = process.argv[2];
const confirm = process.argv.includes('--confirm');

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

async function main() {
  if (!email || email.startsWith('--')) {
    console.error('Usage: node scripts/make-admin.js <email> [--confirm]');
    process.exit(1);
  }

  const url = databaseUrl();
  if (!url) {
    console.error('No DATABASE_URL (env or backend/.env). Nothing to connect to.');
    process.exit(1);
  }

  const client = new Client({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const { rows } = await client.query(
      `SELECT id, email, name, full_name, role, verification_status, firebase_uid,
              is_finder_registered, is_spotter_registered
       FROM users WHERE lower(email) = lower($1)`,
      [email]
    );

    if (rows.length === 0) {
      console.error(`\nNo user with email ${email}.`);
      console.error('');
      console.error('This script does not create users, deliberately. The row is created by');
      console.error('Firebase sign-in, which links firebase_uid and proves the email — a row');
      console.error('invented here could never be signed into.');
      console.error('');
      console.error('So: have them open ParkStop and sign in once, then run this again.');
      console.error('');
      process.exit(1);
    }

    const u = rows[0];

    // Say what is there before touching anything.
    console.log('\nFound:');
    console.log(`  id                  ${u.id}`);
    console.log(`  email               ${u.email}`);
    console.log(`  name                ${u.full_name || u.name || '(none)'}`);
    console.log(`  role                ${u.role}`);
    console.log(`  verification_status ${u.verification_status === null ? 'NULL' : u.verification_status}`);
    console.log(`  signed in before    ${u.firebase_uid ? 'yes' : 'NO — firebase_uid is not set'}`);

    // Which screens they will still be able to reach as an admin.
    //
    // Route access is capability-based, not role-based (utils/roles.js), and
    // the two capabilities are NOT symmetric:
    //
    //   FINDER  -> current === 'FINDER'  || is_finder_registered !== false
    //   SPOTTER -> current === 'SPOTTER' || is_spotter_registered === true
    //
    // is_finder_registered defaults to true and is tested permissively, so
    // driver access survives. is_spotter_registered defaults to FALSE and is
    // tested strictly, so an admin who has never used owner mode is refused
    // the owner routes. Tapping "Owner" on the admin screen fixes it —
    // switch-role sets the flag — but it is worth knowing before, not after.
    console.log(`  driver access       ${u.is_finder_registered !== false ? 'yes' : 'NO'}  (is_finder_registered=${u.is_finder_registered})`);
    console.log(`  owner access        ${u.is_spotter_registered === true ? 'yes' : 'NO'}  (is_spotter_registered=${u.is_spotter_registered})`);
    if (u.is_spotter_registered !== true) {
      console.log('');
      console.log('  Note: owner routes will refuse this account until is_spotter_registered');
      console.log('  is true. Tap "Owner" under "Use the app" on the admin screen once and');
      console.log('  switch-role sets it. Driver access is unaffected.');
    }

    // Never demote. This script has exactly one direction.
    if (String(u.role).toUpperCase() === 'ADMIN') {
      const { rows: c } = await client.query(`SELECT count(*)::int AS n FROM users WHERE role = 'ADMIN'`);
      console.log(`\n  ${u.email} is already ADMIN. Nothing to do.`);
      console.log(`  ${c[0].n} ADMIN account(s) exist.`);
      console.log('');
      return;
    }

    console.log(`\n  Will change role from ${u.role} to ADMIN.`);
    console.log('  Nothing else is touched: not verification_status, not the registration');
    console.log('  flags, not their bank details.');

    if (!confirm) {
      console.log('\nCHECK ONLY — nothing written. Re-run with --confirm to set the role.\n');
      return;
    }

    // Guarded on the role we just read, so a concurrent change loses rather
    // than being silently overwritten.
    const res = await client.query(
      `UPDATE users SET role = 'ADMIN', updated_at = NOW()
       WHERE id = $1 AND role = $2`,
      [u.id, u.role]
    );

    if (res.rowCount === 0) {
      console.error('\n  Nothing updated — the role changed while this was running. Run it again.\n');
      process.exit(1);
    }

    const { rows: after } = await client.query(
      `SELECT count(*)::int AS n FROM users WHERE role = 'ADMIN'`
    );

    console.log(`\n  Done. ${u.email} is now ADMIN.`);
    console.log(`  ${after[0].n} ADMIN account(s) now exist, so the weekly payout run will no`);
    console.log('  longer abort with "no ADMIN account exists".');

    // The role is not as permanent as it looks.
    //
    // Verified before writing this: app/login.tsx posts /auth/social-login as
    // { email, token } at all three of its call sites, with no role, and
    // authController only touches the role when the request carries one
    // ("if (role && role.toUpperCase() !== user.role)"). So signing in leaves
    // ADMIN alone.
    //
    // app/register.tsx posts the SAME endpoint with role included, so going
    // through sign-up again overwrites the role with whatever the screen was
    // set to. There is no ADMIN protection on that path — switchRole has one
    // ("=== 'ADMIN' ? 'ADMIN' : targetRole") and social login does not.
    console.log('');
    console.log('  Keep this in mind: signing IN is safe, but going through SIGN UP again');
    console.log('  will reset this role to FINDER or SPOTTER. Both screens call');
    console.log('  /auth/social-login; only the sign-up screen sends a role, and the');
    console.log('  controller overwrites whatever the request carries. switchRole protects');
    console.log('  ADMIN explicitly; social login does not. Re-run this script if it happens.');
    console.log('');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('make-admin failed:', err.message);
  process.exit(1);
});
