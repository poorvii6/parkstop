#!/usr/bin/env node
/**
 * writeoff-booking.js — close an old completed booking nobody ever paid.
 *
 *   node scripts/writeoff-booking.js 135           # show what it would do
 *   node scripts/writeoff-booking.js 135 --confirm # do it
 *
 * Booking.create blocks a new booking while an earlier one is
 * `status = 'completed'` with `payment_status != 'paid'`. That is deliberate —
 * it stops a driver walking away without paying and simply booking again. But
 * there is currently no way to resolve one, so an abandoned session locks the
 * account for good.
 *
 * This marks the booking CANCELLED with a reason. It does NOT mark it paid:
 * no money arrived, and the records should not claim otherwise. payment_status
 * is left exactly as it was so the history stays honest.
 *
 * It refuses outright if any money is involved — amount_paid above zero, a
 * payment_id, or a payout row. Those need a real decision, not a script.
 */
// Refuse to run against a non-local database unless --production is passed.
// This script writes.
const requireLocalDb = require('./lib/require-local-db');
requireLocalDb({ script: 'writeoff-booking.js', what: 'write off a booking\'s balance' });

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const id = parseInt(process.argv[2], 10);
const confirm = process.argv.includes('--confirm');
if (!id) {
  console.error('Usage: node scripts/writeoff-booking.js <bookingId> [--confirm]');
  process.exit(1);
}

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const p = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return null;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (line.startsWith('DATABASE_URL=')) {
      return line.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '');
    }
  }
  return null;
}

(async () => {
  const url = databaseUrl();
  if (!url) { console.error('No DATABASE_URL.'); process.exit(1); }
  const db = new Client({
    connectionString: url,
    ssl: /\brlwy\.net|railway|amazonaws|supabase/.test(url) ? { rejectUnauthorized: false } : undefined,
  });
  await db.connect();

  try {
    const { rows } = await db.query(
      `SELECT b.*, u.email FROM bookings b JOIN users u ON u.id = b.user_id WHERE b.id = $1`, [id],
    );
    if (!rows.length) { console.log(`\nNo booking #${id}.\n`); return; }
    const b = rows[0];

    const { rows: payouts } = await db.query(`SELECT id, amount, status FROM payouts WHERE booking_id = $1`, [id]);

    console.log(`\nBOOKING #${b.id}  (${b.email})`);
    console.log(`  status         ${b.status}`);
    console.log(`  payment_status ${b.payment_status}`);
    console.log(`  total_price    ₹${Number(b.total_price || 0).toFixed(2)}`);
    console.log(`  amount_paid    ₹${Number(b.amount_paid || 0).toFixed(2)}`);
    console.log(`  payment_id     ${b.payment_id || '(none)'}`);
    console.log(`  payout rows    ${payouts.length}`);

    const reasons = [];
    if (Number(b.amount_paid || 0) > 0) reasons.push(`amount_paid is ₹${Number(b.amount_paid).toFixed(2)}, not zero`);
    if (b.payment_id) reasons.push(`a payment is recorded (${b.payment_id})`);
    if (payouts.length) reasons.push(`${payouts.length} payout row(s) exist — an owner was credited`);
    if (b.status !== 'completed') reasons.push(`status is '${b.status}', not 'completed'`);

    if (reasons.length) {
      console.log('\nREFUSED. Money is involved, or this is not a stuck completed booking:');
      reasons.forEach((r) => console.log('  - ' + r));
      console.log('\nDecide what should happen to the money first. This script will not guess.\n');
      return;
    }

    if (!confirm) {
      console.log('\nWould mark this booking cancelled, reason "unpaid_written_off".');
      console.log('payment_status stays as it is — no money arrived and the record should say so.');
      console.log('\nRe-run with --confirm to do it.\n');
      return;
    }

    const res = await db.query(
      `UPDATE bookings
          SET status = 'cancelled',
              cancellation_reason = 'unpaid_written_off',
              updated_at = NOW()
        WHERE id = $1 AND status = 'completed'`,
      [id],
    );
    console.log(res.rowCount ? `\nBooking #${id} written off. The account can book again.\n`
                             : `\nNothing changed — it is no longer 'completed'.\n`);
  } finally {
    await db.end();
  }
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
