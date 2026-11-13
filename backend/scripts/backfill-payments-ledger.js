#!/usr/bin/env node
/**
 * backfill-payments-ledger.js — one payments row per already-settled booking.
 *
 *   node scripts/backfill-payments-ledger.js            # dry run, writes nothing
 *   node scripts/backfill-payments-ledger.js --confirm  # actually insert
 *
 * WHY THIS MATTERS, and why it should be run straight after deploying:
 *
 * _refundDuplicatePayment decides whether an incoming payment is a duplicate
 * by asking the payments ledger whether it has seen that payment id before.
 * Bookings settled before the ledger existed have no rows, so a redelivered
 * webhook for one of them reads as "never seen". The service refuses to judge
 * a booking with an empty ledger and alerts an admin instead of refunding, so
 * nothing is given away in the meantime — but every such retry is a page for a
 * human until this has run.
 *
 * Safe to run twice. razorpay_payment_id is UNIQUE, and the insert is written
 * as INSERT ... ON CONFLICT DO NOTHING, so a second run inserts nothing and
 * reports zero. It never updates or deletes an existing row.
 *
 * WHAT IT CANNOT RECOVER: bookings.payment_id holds only the MOST RECENT
 * payment. A booking paid twice -- a prepayment and an overstay top-up -- has
 * lost the earlier id entirely, so only the last one can be backfilled. The
 * row it writes therefore carries the booking's whole amount_paid, which for
 * those bookings overstates what that single payment actually brought in. It
 * is the best available record, not a true one, and the summary says so. Rows
 * are written with status 'backfilled' rather than 'captured' precisely so
 * they can be told apart from rows written by a live payment.
 *
 * Uses `pg` directly rather than Prisma, same as the other scripts here: one
 * less platform-specific binary to care about.
 */
// Refuse to run against a non-local database unless --production is passed.
// This script writes.
const requireLocalDb = require('./lib/require-local-db');
requireLocalDb({ script: 'backfill-payments-ledger.js', what: 'insert payments ledger rows' });

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

const rupees = (n) => `₹${Number(n || 0).toFixed(2)}`;

async function main() {
  const confirm = process.argv.includes('--confirm');
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
    // Does the table exist yet? A clearer message than a raw SQL error.
    const { rows: tbl } = await client.query(
      `SELECT to_regclass('public.payments') AS t`
    );
    if (!tbl[0].t) {
      console.error('The payments table does not exist. Run `npx prisma migrate deploy` first.');
      process.exit(1);
    }

    // Every settled booking whose payment is not already in the ledger.
    const { rows } = await client.query(`
      SELECT b.id,
             b.payment_id,
             COALESCE(b.amount_paid, 0) AS amount_paid,
             b.payment_status,
             b.created_at
      FROM bookings b
      LEFT JOIN payments p ON p.razorpay_payment_id = b.payment_id
      WHERE b.payment_id IS NOT NULL
        AND b.payment_id <> ''
        AND p.id IS NULL
      ORDER BY b.id
    `);

    if (rows.length === 0) {
      console.log('Nothing to backfill — every booking with a payment id already has a ledger row.');
      return;
    }

    let total = 0;
    let zero = 0;
    console.log(`${rows.length} booking(s) with a payment id and no ledger row:\n`);
    for (const r of rows) {
      const amt = Number(r.amount_paid);
      total += amt;
      if (!(amt > 0)) zero += 1;
      console.log(
        `  booking ${String(r.id).padEnd(7)} ${String(r.payment_id).padEnd(22)} ` +
        `${rupees(amt).padStart(11)}  ${r.payment_status}`
      );
    }

    console.log(`\n  ${rows.length} row(s), ${rupees(total)} in total.`);
    if (zero > 0) {
      console.log(`  ${zero} of them record ₹0 collected — written as 0, not guessed at.`);
    }
    console.log(
      '\n  Each row records the booking\'s whole amount_paid against its most recent\n' +
      '  payment id. For a booking paid twice the earlier id is gone, so that row\n' +
      '  overstates what the single surviving payment brought in. It is the best\n' +
      '  available record, not a true one.'
    );

    if (!confirm) {
      console.log('\nDRY RUN — nothing written. Re-run with --confirm to insert.');
      return;
    }

    // ON CONFLICT DO NOTHING makes a second run a no-op even if the set above
    // was computed a moment before someone else inserted the same id.
    const result = await client.query(`
      INSERT INTO payments (booking_id, razorpay_payment_id, amount, arrears_cleared, status, created_at)
      SELECT b.id, b.payment_id, COALESCE(b.amount_paid, 0), 0, 'backfilled', COALESCE(b.created_at, NOW())
      FROM bookings b
      LEFT JOIN payments p ON p.razorpay_payment_id = b.payment_id
      WHERE b.payment_id IS NOT NULL
        AND b.payment_id <> ''
        AND p.id IS NULL
      ON CONFLICT (razorpay_payment_id) DO NOTHING
    `);

    console.log(`\nInserted ${result.rowCount} row(s). Status 'backfilled', so they can be told`);
    console.log("from rows written by a live payment ('captured').");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
