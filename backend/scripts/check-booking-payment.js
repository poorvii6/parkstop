#!/usr/bin/env node
/**
 * check-booking-payment.js — why does a booking still say unpaid?
 *
 *   node scripts/check-booking-payment.js you@example.com
 *   node scripts/check-booking-payment.js 123          # a booking id
 *
 * Read-only. It changes nothing.
 *
 * Booking.create refuses a new booking while an earlier one is
 * `status = 'completed'` with `payment_status != 'paid'` — that is the
 * "Finish your last parking" dialog. This shows which booking is blocking,
 * then asks Razorpay whether the money actually arrived.
 *
 * The two answers mean different things:
 *   money at Razorpay, unpaid here  -> settlement never ran (webhook missing,
 *                                      or the app's verify call failed)
 *   no money at Razorpay            -> the payment genuinely did not complete
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node scripts/check-booking-payment.js <email | bookingId | --all>');
  console.error('  --all   every booking anywhere that is blocking its owner from booking again');
  process.exit(1);
}

function env(key) {
  if (process.env[key]) return process.env[key];
  const p = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return null;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (line.startsWith(key + '=')) {
      return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
  return null;
}

const money = (v) => '₹' + Number(v || 0).toFixed(2);

async function razorpay(pathname) {
  const id = env('RAZORPAY_KEY_ID'), secret = env('RAZORPAY_KEY_SECRET');
  if (!id || !secret) return { error: 'no Razorpay keys in .env' };
  const auth = Buffer.from(`${id}:${secret}`).toString('base64');
  const res = await fetch('https://api.razorpay.com/v1' + pathname, {
    headers: { Authorization: `Basic ${auth}` },
  });
  const body = await res.json();
  return res.ok ? body : { error: body?.error?.description || res.status };
}

(async () => {
  const url = env('DATABASE_URL');
  if (!url) { console.error('No DATABASE_URL.'); process.exit(1); }
  const db = new Client({
    connectionString: url,
    ssl: /\brlwy\.net|railway|amazonaws|supabase/.test(url) ? { rejectUnauthorized: false } : undefined,
  });
  await db.connect();

  try {
    const byId = /^\d+$/.test(arg);
    const all = arg === '--all';
    // --all ignores the per-account limit: the dialog can be caused by a
    // booking far older than the last ten, or by a different account than the
    // one you expected the phone to be signed in as.
    const { rows } = await db.query(
      all
        ? `SELECT b.*, u.email FROM bookings b JOIN users u ON u.id = b.user_id
            WHERE b.status = 'completed' AND b.payment_mode = 'online'
              AND b.payment_status IS DISTINCT FROM 'paid'
            ORDER BY b.id DESC`
        : byId
        ? `SELECT b.*, u.email FROM bookings b JOIN users u ON u.id = b.user_id WHERE b.id = $1`
        : `SELECT b.*, u.email FROM bookings b JOIN users u ON u.id = b.user_id
            WHERE lower(u.email) = lower($1)
            ORDER BY b.id DESC LIMIT 25`,
      all ? [] : [arg],
    );

    if (!rows.length) { console.log('\nNo bookings found.\n'); return; }

    const blocking = rows.filter(
      (b) => b.status === 'completed' && b.payment_mode === 'online' && b.payment_status !== 'paid',
    );

    console.log(`\nBOOKINGS (${rows.length})`);
    for (const b of rows) {
      const blocks = blocking.some((x) => x.id === b.id);
      console.log(`\n  #${b.id}  ${b.status} / ${b.payment_status}  (${b.email})${blocks ? '   <-- BLOCKS NEW BOOKINGS' : ''}`);
      console.log(`    total_price   ${money(b.total_price)}   advance_fee ${money(b.advance_fee)}   amount_paid ${money(b.amount_paid)}`);
      console.log(`    payment_id    ${b.payment_id || '(none recorded)'}`);
      console.log(`    ended         ${b.actual_end_time ? new Date(b.actual_end_time).toLocaleString() : '-'}`);
    }

    if (!blocking.length) {
      console.log('\nNothing is blocking a new booking.\n');
      return;
    }

    console.log('\n\nASKING RAZORPAY ABOUT THE BLOCKING BOOKING(S)');
    const orders = await razorpay('/orders?count=100');
    if (orders.error) {
      console.log('  Could not reach Razorpay:', orders.error);
      return;
    }

    for (const b of blocking) {
      console.log(`\n  booking #${b.id}`);
      const mine = (orders.items || []).filter((o) => String(o.notes?.booking_id) === String(b.id));
      if (!mine.length) {
        console.log('    No Razorpay order was ever created for this booking.');
        console.log('    -> the payment screen was never completed. Nothing was charged.');
        continue;
      }
      for (const o of mine) {
        console.log(`    order ${o.id}  ${o.status}  ${money(o.amount / 100)}  attempts: ${o.attempts}`);
        if (o.status === 'paid' || o.attempts > 0) {
          const pays = await razorpay(`/orders/${o.id}/payments`);
          for (const p of (pays.items || [])) {
            console.log(`      payment ${p.id}  ${p.status}  ${money(p.amount / 100)}  ${p.method || ''}`);
            if (p.status === 'captured') {
              console.log('      ^^ MONEY WAS TAKEN but the booking was never marked paid.');
              console.log('         Settlement did not run. The webhook is not registered,');
              console.log('         so nothing confirmed this payment server-side.');
            }
          }
        }
      }
    }
    console.log('');
  } finally {
    await db.end();
  }
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
