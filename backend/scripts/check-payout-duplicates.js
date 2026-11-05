#!/usr/bin/env node
/**
 * check-payout-duplicates.js — is it safe to add @@unique([booking_id]) to payouts?
 *
 *   node scripts/check-payout-duplicates.js
 *
 * Run this BEFORE deploying the schema change. `npm start` runs
 * `prisma db push`, so if two payout rows share a booking_id the push fails,
 * start fails with it, and the server does not come up.
 *
 * Read-only. It changes nothing. If it finds duplicates it prints them and
 * tells you what to decide; it will not delete a payment record on its own.
 *
 * Uses `pg` directly rather than Prisma — one less platform-specific binary
 * to care about, same as scripts/approve-owner.js.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

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
    const { rows: totals } = await db.query(
      `SELECT COUNT(*)::int AS all_rows,
              COUNT(booking_id)::int AS with_booking,
              COUNT(*)::int - COUNT(booking_id)::int AS without_booking
         FROM payouts`,
    );
    const t = totals[0];
    console.log('\nPAYOUTS');
    console.log(`  rows in total        ${t.all_rows}`);
    console.log(`  tied to a booking    ${t.with_booking}`);
    console.log(`  not tied to one      ${t.without_booking}   (these are fine, NULLs do not clash)`);

    const { rows: dups } = await db.query(
      `SELECT booking_id, COUNT(*)::int AS copies,
              SUM(amount)   AS total_credited,
              MIN(amount)   AS smallest,
              MAX(amount)   AS largest,
              array_agg(id ORDER BY created_at) AS payout_ids,
              array_agg(DISTINCT user_id)       AS owner_ids
         FROM payouts
        WHERE booking_id IS NOT NULL
        GROUP BY booking_id
       HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC, booking_id`,
    );

    if (dups.length === 0) {
      console.log('\nDUPLICATES\n  none.');
      console.log('\nSAFE TO DEPLOY. `prisma db push` will add the unique rule cleanly.\n');
      return;
    }

    console.log(`\nDUPLICATES (${dups.length} booking${dups.length > 1 ? 's' : ''} credited more than once)`);
    for (const d of dups) {
      console.log(`\n  booking #${d.booking_id}`);
      console.log(`    payout rows       ${d.copies}  (ids ${d.payout_ids.join(', ')})`);
      console.log(`    owner(s)          ${d.owner_ids.join(', ')}`);
      console.log(`    credited in total ₹${Number(d.total_credited).toFixed(2)}`);
      console.log(`    each row          ₹${Number(d.smallest).toFixed(2)} … ₹${Number(d.largest).toFixed(2)}`);
    }

    console.log('\nDO NOT DEPLOY YET.');
    console.log('`npm start` runs `prisma db push`, which will fail on these, and the');
    console.log('server will not start.\n');
    console.log('Each of these is an owner who was credited twice for one booking, so');
    console.log('decide per booking before deleting anything:');
    console.log('  - keep the earliest payout row and remove the later one(s), AND');
    console.log('  - take the extra off that owner\'s balance, or they keep money twice.');
    console.log('\nThis script will not do that for you — it is real money and it is not reversible.\n');
  } finally {
    await db.end();
  }
})().catch((e) => {
  console.error('Failed:', e.message);
  process.exit(1);
});
