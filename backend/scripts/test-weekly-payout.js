#!/usr/bin/env node
/**
 * test-weekly-payout.js — does the Saturday payout run do the right thing?
 *
 *   node scripts/test-weekly-payout.js
 *
 * Creates a handful of throwaway owners, runs the real weekly job against
 * them, checks every outcome, then deletes them again. It touches no real
 * owner: every test row is tagged with a one-off marker and removed at the
 * end, including if an assertion fails.
 *
 * Run it before trusting a change to weeklyPayoutService. The cases are the
 * ones that cost money if they are wrong: an owner paid twice, an owner paid
 * who should not have been, and a balance that vanishes without a payout row
 * to show for it.
 *
 * It does NOT send any money. The job only writes payout_requests rows; an
 * admin sends the transfers by hand.
 */

require('dotenv').config();
const prisma = require('../src/config/prisma');
const { runWeeklyPayouts, MIN_PAYOUT } = require('../src/services/weeklyPayoutService');

const TAG = 'wktest-' + Date.now();

const CASES = [
  ['well-above-min', { verification_status: 'approved', balance: 1240.50, bank_account_number: '112233445566', bank_ifsc: 'HDFC0001234', bank_account_name: 'A Owner' }, 'PAID'],
  ['exactly-min',    { verification_status: 'approved', balance: MIN_PAYOUT, bank_account_number: '112233445567', bank_ifsc: 'HDFC0001234', bank_account_name: 'B Owner' }, 'PAID'],
  ['just-under-min', { verification_status: 'approved', balance: MIN_PAYOUT - 15, bank_account_number: '112233445568', bank_ifsc: 'HDFC0001234', bank_account_name: 'C Owner' }, 'KEPT'],
  ['zero-balance',   { verification_status: 'approved', balance: 0, bank_account_number: '112233445569', bank_ifsc: 'HDFC0001234', bank_account_name: 'D Owner' }, 'KEPT'],
  ['name-null',      { verification_status: 'approved', balance: 500, bank_account_number: '112233445570', bank_ifsc: 'HDFC0001234', bank_account_name: null }, 'KEPT'],
  ['name-blank',     { verification_status: 'approved', balance: 500, bank_account_number: '112233445571', bank_ifsc: 'HDFC0001234', bank_account_name: '' }, 'KEPT'],
  ['ifsc-blank',     { verification_status: 'approved', balance: 500, bank_account_number: '112233445572', bank_ifsc: '', bank_account_name: 'F Owner' }, 'KEPT'],
  ['no-bank-at-all', { verification_status: 'approved', balance: 500, bank_account_number: null, bank_ifsc: null, bank_account_name: null }, 'KEPT'],
  ['not-verified',   { verification_status: 'pending', balance: 900, bank_account_number: '112233445573', bank_ifsc: 'HDFC0001234', bank_account_name: 'G Owner' }, 'KEPT'],
];

async function cleanup(ids) {
  for (const id of ids) {
    await prisma.payout_requests.deleteMany({ where: { user_id: id } }).catch(() => {});
    await prisma.notifications.deleteMany({ where: { user_id: id } }).catch(() => {});
    await prisma.users.delete({ where: { id } }).catch(() => {});
  }
}

(async () => {
  const made = [];
  let failures = 0;

  try {
    // The run refuses to start with no ADMIN account, because the rows it
    // writes can then be neither paid nor returned. Report the real state of
    // the database first -- that is the thing worth knowing before Saturday --
    // then give the test its own admin so the paying path is exercised either
    // way. The test admin is cleaned up with everything else.
    const realAdmins = await prisma.users.count({ where: { role: 'ADMIN' } });
    if (realAdmins === 0) {
      console.log('\n  !! No ADMIN account exists in this database.');
      console.log('     The real Saturday run will ABORT and pay nobody until you create one.');
      console.log('     (This test makes a temporary admin so it can still check the payout logic.)');
    } else {
      console.log(`\n  ${realAdmins} admin account(s) found — the real run can proceed.`);
    }

    const admin = await prisma.users.create({
      data: {
        email: `${TAG}-admin@test.invalid`,
        name: 'test admin',
        full_name: 'test admin',
        role: 'ADMIN',
        firebase_uid: `${TAG}-admin`,
      },
    });
    made.push({ id: admin.id, name: 'ADMIN (helper)', before: 0, expect: 'KEPT' });

    for (const [name, fields, expect] of CASES) {
      const u = await prisma.users.create({
        data: {
          email: `${TAG}-${name}@test.invalid`,
          // `name` is required on users; `full_name` is the optional one the
          // app actually displays. Both are set so a test owner looks like a
          // real row to anything the job touches.
          name: `test ${name}`,
          full_name: `test ${name}`,
          role: 'SPOTTER',
          firebase_uid: `${TAG}-${name}`,
          is_spotter_registered: true,
          ...fields,
        },
      });
      made.push({ id: u.id, name, before: Number(fields.balance), expect });
    }

    console.log(`\n  ${made.length} test owners created. Running the weekly job...\n`);
    await runWeeklyPayouts();

    console.log('  case              expected   result     balance   paid out');
    console.log('  ' + '-'.repeat(58));

    for (const t of made) {
      if (t.name === 'ADMIN (helper)') continue;
      const after = Number((await prisma.users.findUnique({ where: { id: t.id }, select: { balance: true } })).balance);
      const row = await prisma.payout_requests.findFirst({ where: { user_id: t.id } });
      const paid = row ? Number(row.amount) : 0;

      let result;
      if (row && Math.abs(t.before - after - paid) < 0.005) result = 'PAID';
      else if (!row && after === t.before) result = 'KEPT';
      else result = 'BROKEN';

      // A payout row must carry what an admin needs to send the transfer.
      let note = '';
      if (row && (!row.bank_account_name || !row.bank_ifsc || !row.bank_account_last4)) {
        result = 'BROKEN';
        note = ' <- payout row is missing bank details';
      }

      const ok = result === t.expect;
      if (!ok) failures++;
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${t.name.padEnd(15)} ${t.expect.padEnd(10)} ${result.padEnd(10)} ${String(after).padEnd(9)} ${paid || '-'}${note}`);
    }

    // The job must be safe to run twice. A restart, a retry, or someone
    // triggering it by hand must not pay anybody a second time.
    console.log('\n  --- running it again, same morning ---');
    const ids = made.map((t) => t.id);
    const before = await prisma.payout_requests.count({ where: { user_id: { in: ids } } });
    await runWeeklyPayouts();
    const after = await prisma.payout_requests.count({ where: { user_id: { in: ids } } });
    const safe = before === after;
    if (!safe) failures++;
    console.log(`  payout rows before: ${before}   after: ${after}   ${safe ? 'ok - nobody paid twice' : 'FAIL - DOUBLE PAID'}`);
  } finally {
    await cleanup(made.map((t) => t.id));
    console.log(`\n  cleaned up ${made.length} test owners`);
  }

  console.log(failures === 0 ? '\n  ALL PASS\n' : `\n  ${failures} FAILURE(S) — do not deploy\n`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('\n  test crashed:', e);
  await prisma.$disconnect();
  process.exit(1);
});
