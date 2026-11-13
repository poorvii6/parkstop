/**
 * scripts/make-admin.js — granting and removing the ADMIN role.
 *
 * Driven as a real process against a real database, because that is what the
 * script is: `pg` and SQL, with no exported functions to unit test. Mocking it
 * would only test the mocks.
 *
 * The guard that matters most is the LAST-ADMIN refusal. weeklyPayoutService
 * counts ADMIN accounts and aborts the run at zero, because it moves balances
 * out of owners' wallets into 'requested' rows that only an admin can pay or
 * return. Removing the last admin would stop owners being paid and say nothing
 * about why — the run just logs and returns.
 *
 *   npm run test:integration
 */
const path = require('path');
const { execFileSync } = require('child_process');
const prisma = require('../../src/config/prisma');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'make-admin.js');

/** Run the script and capture everything it printed, exit code included. */
const run = (args) => {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    return { code: 0, out: stdout };
  } catch (err) {
    return {
      code: err.status === undefined ? 1 : err.status,
      out: `${err.stdout || ''}${err.stderr || ''}`,
    };
  }
};

const EMAILS = ['mk-a@test.invalid', 'mk-b@test.invalid', 'mk-owner@test.invalid'];

const makeUser = (email, over = {}) =>
  prisma.users.create({
    data: {
      name: 'Script Test',
      full_name: 'Script Test',
      email,
      firebase_uid: `uid_${email}`,
      role: 'FINDER',
      ...over,
    },
  });

const roleOf = async (email) =>
  (await prisma.users.findFirst({ where: { email }, select: { role: true } }))?.role;

const wipe = () => prisma.users.deleteMany({ where: { email: { in: EMAILS } } });

/**
 * Admin accounts belonging to other tests or to seed data would make the
 * last-admin arithmetic unpredictable, so they are parked for the duration and
 * put back afterwards.
 */
let parked = [];

beforeAll(async () => {
  parked = await prisma.users.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
  if (parked.length) {
    await prisma.users.updateMany({
      where: { id: { in: parked.map((p) => p.id) } },
      data: { role: 'FINDER' },
    });
  }
});

afterAll(async () => {
  await wipe();
  if (parked.length) {
    await prisma.users.updateMany({
      where: { id: { in: parked.map((p) => p.id) } },
      data: { role: 'ADMIN' },
    });
  }
  await prisma.$disconnect();
});

beforeEach(wipe);

describe('granting ADMIN', () => {
  test('a missing account is refused, and is not created', async () => {
    const r = run(['nobody@test.invalid', '--confirm']);

    expect(r.code).toBe(1);
    expect(r.out).toMatch(/No user with email/);
    expect(r.out).toMatch(/sign in once/i);
    expect(await prisma.users.count({ where: { email: 'nobody@test.invalid' } })).toBe(0);
  });

  test('check-only writes nothing', async () => {
    await makeUser(EMAILS[0]);

    const r = run([EMAILS[0]]);

    expect(r.out).toMatch(/CHECK ONLY/);
    expect(await roleOf(EMAILS[0])).toBe('FINDER');
  });

  test('--confirm promotes and reports the new admin count', async () => {
    await makeUser(EMAILS[0]);

    const r = run([EMAILS[0], '--confirm']);

    expect(r.code).toBe(0);
    expect(await roleOf(EMAILS[0])).toBe('ADMIN');
    expect(r.out).toMatch(/1 ADMIN account\(s\) now exist/);
  });

  test('running it twice is safe', async () => {
    await makeUser(EMAILS[0]);
    run([EMAILS[0], '--confirm']);

    const r = run([EMAILS[0], '--confirm']);

    expect(r.out).toMatch(/already ADMIN/);
    expect(await roleOf(EMAILS[0])).toBe('ADMIN');
  });

  test('it prints whether driver and owner access survive', async () => {
    await makeUser(EMAILS[0], { is_spotter_registered: false });

    const r = run([EMAILS[0]]);

    expect(r.out).toMatch(/driver access\s+yes/);
    expect(r.out).toMatch(/owner access\s+NO/);
    expect(r.out).toMatch(/until is_spotter_registered/);
  });
});

describe('removing ADMIN', () => {
  test('REFUSES to remove the last admin, and says how many there are', async () => {
    await makeUser(EMAILS[0], { role: 'ADMIN' });

    const r = run([EMAILS[0], '--remove', '--confirm']);

    expect(r.code).toBe(1);
    expect(r.out).toMatch(/REFUSED/);
    expect(r.out).toMatch(/only ADMIN account/);
    expect(r.out).toMatch(/1 ADMIN account\(s\) exist/);
    // The critical assertion: they are still an admin.
    expect(await roleOf(EMAILS[0])).toBe('ADMIN');
  });

  test('the refusal explains the payout consequence, not just the rule', async () => {
    await makeUser(EMAILS[0], { role: 'ADMIN' });

    const r = run([EMAILS[0], '--remove', '--confirm']);

    expect(r.out).toMatch(/payout run aborts/i);
    expect(r.out).toMatch(/Promote\s+somebody else first/i);
  });

  test('removes one when another admin remains', async () => {
    await makeUser(EMAILS[0], { role: 'ADMIN' });
    await makeUser(EMAILS[1], { role: 'ADMIN' });

    const r = run([EMAILS[0], '--remove', '--confirm']);

    expect(r.code).toBe(0);
    expect(await roleOf(EMAILS[0])).toBe('FINDER');
    expect(await roleOf(EMAILS[1])).toBe('ADMIN'); // the other one is untouched
    expect(r.out).toMatch(/1 ADMIN account\(s\) now exist/);
  });

  test('check-only writes nothing', async () => {
    await makeUser(EMAILS[0], { role: 'ADMIN' });
    await makeUser(EMAILS[1], { role: 'ADMIN' });

    const r = run([EMAILS[0], '--remove']);

    expect(r.out).toMatch(/CHECK ONLY/);
    expect(r.out).toMatch(/Will change role from ADMIN to FINDER/);
    expect(await roleOf(EMAILS[0])).toBe('ADMIN');
  });

  test('an owner-only account lands on SPOTTER, not FINDER', async () => {
    // The role comes from the capability flags, not from a guess.
    await makeUser(EMAILS[2], {
      role: 'ADMIN',
      is_finder_registered: false,
      is_spotter_registered: true,
    });
    await makeUser(EMAILS[1], { role: 'ADMIN' });

    run([EMAILS[2], '--remove', '--confirm']);

    expect(await roleOf(EMAILS[2])).toBe('SPOTTER');
  });

  test('a dual account lands on FINDER, and keeps owner access', async () => {
    // Dual users are sent to the role-selection screen anyway, and the flags
    // are left alone, so owner mode stays one tap away.
    await makeUser(EMAILS[2], {
      role: 'ADMIN',
      is_finder_registered: true,
      is_spotter_registered: true,
    });
    await makeUser(EMAILS[1], { role: 'ADMIN' });

    run([EMAILS[2], '--remove', '--confirm']);

    const u = await prisma.users.findFirst({ where: { email: EMAILS[2] } });
    expect(u.role).toBe('FINDER');
    expect(u.is_spotter_registered).toBe(true); // untouched
  });

  test('removing from a non-admin does nothing', async () => {
    await makeUser(EMAILS[0]);

    const r = run([EMAILS[0], '--remove', '--confirm']);

    expect(r.out).toMatch(/is not an ADMIN/);
    expect(await roleOf(EMAILS[0])).toBe('FINDER');
  });
});
