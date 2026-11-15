/**
 * THE GATE SWITCH — both states, and the OFF state first.
 *
 * Per-spot verification ships behind SPOT_VERIFICATION_GATE, default OFF.
 * Railway deploys from main, but the owner's upload screen needs an app
 * release, and in the gap between the two an owner on the installed build
 * would submit a spot, watch it go invisible, and have no screen to fix it
 * with — the gate with no door, arriving through the release gap rather than
 * through the code.
 *
 * OFF IS THE PATH ABOUT TO BE IN PRODUCTION, so it is tested at least as hard
 * as on. A suite that only exercised the gate on would be testing the state
 * nobody is in yet.
 *
 * The flag is read in exactly ONE place — isSpotGateEnabled in
 * constants/spotVerification.js — and everything else asks a question about
 * the domain and gets an answer. A flag checked in four places is four places
 * to drift, which is the dashboard-select bug again. The last describe block
 * here asserts that single read point.
 *
 *   npx jest tests/unit/spotGate.test.js
 */
const fs = require('fs');
const path = require('path');

const { Prisma } = require('@prisma/client');

const C = require('../../src/constants/spotVerification');
const Policy = require('../../src/services/SpotVerificationPolicy');

const { SPOT_VERIFICATION_STATUS: S, ALL_SPOT_VERIFICATION_STATUSES } = C;

/** Run `fn` with the gate in a known state, and put the variable back. */
function withGate(value, fn) {
  const before = process.env[C.GATE_VARIABLE];
  if (value === undefined) delete process.env[C.GATE_VARIABLE];
  else process.env[C.GATE_VARIABLE] = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env[C.GATE_VARIABLE];
    else process.env[C.GATE_VARIABLE] = before;
  }
}

const off = (fn) => withGate(undefined, fn);
const on = (fn) => withGate('on', fn);

describe('what turns the gate on', () => {
  test('the variable is SPOT_VERIFICATION_GATE and the value is exactly "on"', () => {
    // Stated as a test because it is what gets typed into Railway.
    expect(C.GATE_VARIABLE).toBe('SPOT_VERIFICATION_GATE');
    expect(C.GATE_ON_VALUE).toBe('on');
    expect(on(() => C.isSpotGateEnabled())).toBe(true);
  });

  test('unset is off', () => {
    expect(off(() => C.isSpotGateEnabled())).toBe(false);
  });

  test('whitespace and case around "on" still count', () => {
    // A value pasted into a Railway field with a stray space must not silently
    // leave the gate off after someone believes they switched it on.
    for (const v of ['on', 'ON', 'On', ' on', 'on ', '  On  ']) {
      expect(withGate(v, () => C.isSpotGateEnabled())).toBe(true);
    }
  });

  test('anything else is off, and fails SAFE in the deploy-order sense', () => {
    // "off" here means "behaves as before", which is the state that cannot
    // strand an owner. So a typo leaves the world unchanged rather than
    // half-enforcing something.
    for (const v of ['', 'off', 'true', '1', 'yes', 'enabled', 'onn', 'no']) {
      expect(withGate(v, () => C.isSpotGateEnabled())).toBe(false);
    }
  });
});

describe('with the gate OFF, a spot is visible whatever its verification says', () => {
  test('every status is visible to drivers, including not_started and null', () => {
    off(() => {
      for (const status of [...ALL_SPOT_VERIFICATION_STATUSES, null, undefined, 'something_new']) {
        expect(C.isVisibleToDrivers(status)).toBe(true);
      }
    });
  });

  test('the Prisma filter is ABSENT, not widened', () => {
    // Absent matters. `{ in: [...everything] }` would still exclude a NULL
    // status, so a row that somehow missed the backfill would stay hidden —
    // and "off" has to mean no change at all.
    expect(off(() => C.driverVisibilityWhere())).toEqual({});
  });

  test('the raw SQL fragment is empty, so the clause disappears', () => {
    const frag = off(() => C.driverVisibilitySql());

    expect(frag).toEqual(Prisma.empty);
    // Composed into a query it leaves no clause and no stray parameter.
    const q = Prisma.sql`SELECT 1 WHERE is_active = true ${frag} AND id = ${7}`;
    expect(q.sql.replace(/\s+/g, ' ')).toBe('SELECT 1 WHERE is_active = true AND id = ?');
    expect(q.values).toEqual([7]);
  });

  test('no pin is frozen by the spot\'s own status', () => {
    off(() => {
      for (const status of ALL_SPOT_VERIFICATION_STATUSES) {
        expect(C.isPinFrozen(status)).toBe(false);
      }
    });
  });

  test('the pin freeze falls back to the OWNER rule, as before stage 1', () => {
    off(() => {
      // An approved owner's pin is fixed — drivers are navigating to it.
      const frozen = C.pinFreezeReason({ spotStatus: S.NOT_STARTED, ownerApproved: true });
      expect(frozen?.code).toBe('OWNER_APPROVED');
      expect(frozen?.message).toMatch(/now that your account is verified/);

      // An unverified owner's is not: nothing is live yet.
      expect(C.pinFreezeReason({ spotStatus: S.APPROVED, ownerApproved: false })).toBeNull();
      expect(C.pinFreezeReason({ spotStatus: S.DESK_PENDING, ownerApproved: false })).toBeNull();
    });
  });

  test('the owner is promised nothing, because the spot is already live', () => {
    const out = off(() => Policy.ownerSummary(
      { id: 1, title: 'Front driveway', spot_verification_status: S.DESK_PENDING, latitude: 12.9, longitude: 77.5 },
      { status: S.DESK_PENDING, submitted_at: new Date(Date.now() - 3600 * 1000) }
    ));

    expect(out.gate_enforced).toBe(false);
    expect(out.is_live).toBe(true);
    // No countdown. Promising "live within 47 hours" about a listing drivers
    // can already book would be false in the one direction that matters.
    expect(out.hours_left).toBeNull();
    expect(out.promised_hours).toBeNull();
    expect(out.message).toMatch(/Live on ParkStop/);
    expect(out.message).not.toMatch(/48|hour\(s\)/);
  });

  test('a rejected spot is told so, and told it is still live', () => {
    const out = off(() => Policy.ownerSummary(
      { id: 1, spot_verification_status: S.REJECTED, latitude: 12.9, longitude: 77.5 },
      { status: S.REJECTED, rejection_reason: 'The address does not match.' }
    ));

    expect(out.is_live).toBe(true);
    expect(out.message).toMatch(/still live/);
    expect(out.rejection_reason).toMatch(/does not match/);
  });

  test('the submission is still recorded, reviewed and measured', () => {
    // The feature is not disabled — only its consequences are held back, so
    // the whole flow can be exercised before anybody is subject to it.
    off(() => {
      // The clock still measures, for the admin queue.
      const wait = Policy.waitFor({ status: S.DESK_PENDING, submittedAt: new Date(Date.now() - 40 * 3600 * 1000) });
      expect(wait.waiting_hours).toBeGreaterThan(39);
      expect(wait.sla).toBe(Policy.SLA.AT_RISK);

      // The desk checks still decide.
      expect(Policy.deskPassBlockers({ nameVerdict: 'NO_MATCH', addressVerdict: 'consistent' }))
        .toEqual([expect.objectContaining({ code: 'NAME_NO_MATCH' })]);

      // And both stages are still required before anything reads as approved.
      expect(Policy.deskAndFieldPassed({
        status: S.DESK_APPROVED, desk_reviewed_at: new Date(), field_record_found: true, field_checked_at: new Date(),
      })).toBe(true);
      expect(Policy.deskAndFieldPassed({ status: S.DESK_APPROVED, desk_reviewed_at: new Date() })).toBe(false);
    });
  });

  test('what is still missing is unchanged — the owner can complete a submission', () => {
    const gaps = off(() => Policy.submissionGaps({ relationship: 'tenant' }, {}));
    expect(gaps.map((g) => g.code)).toEqual(['NO_DOCUMENT', 'NO_LANDLORD_CONSENT', 'NO_PIN']);
  });
});

describe('with the gate ON, stages 1-4b apply as built', () => {
  test('only approved and grandfathered are visible', () => {
    on(() => {
      expect(C.isVisibleToDrivers(S.APPROVED)).toBe(true);
      expect(C.isVisibleToDrivers(S.GRANDFATHERED)).toBe(true);
      for (const status of [S.NOT_STARTED, S.IN_PROGRESS, S.DESK_PENDING, S.DESK_APPROVED, S.REJECTED, null]) {
        expect(C.isVisibleToDrivers(status)).toBe(false);
      }
    });
  });

  test('the filter is present, in both query shapes', () => {
    on(() => {
      expect(C.driverVisibilityWhere()).toEqual({
        spot_verification_status: { in: C.VISIBLE_SPOT_STATUSES },
      });
      const q = Prisma.sql`SELECT 1 WHERE true ${C.driverVisibilitySql()}`;
      expect(q.sql).toMatch(/spot_verification_status = ANY/);
      expect(q.values).toEqual([C.VISIBLE_SPOT_STATUSES]);
    });
  });

  test('the pin freeze is keyed on the SPOT, not the owner', () => {
    on(() => {
      // Live, so fixed — whatever the owner's own status is.
      expect(C.pinFreezeReason({ spotStatus: S.APPROVED, ownerApproved: false })?.code).toBe('LIVE');
      expect(C.pinFreezeReason({ spotStatus: S.GRANDFATHERED, ownerApproved: false })?.code).toBe('LIVE');
      // Under review, so fixed: the desk check measured the document against
      // this pin, and a pin that could move afterwards means the check passed
      // about somewhere else.
      expect(C.pinFreezeReason({ spotStatus: S.DESK_PENDING, ownerApproved: true })?.code).toBe('UNDER_REVIEW');
      expect(C.pinFreezeReason({ spotStatus: S.DESK_APPROVED, ownerApproved: true })?.code).toBe('UNDER_REVIEW');
      // And free otherwise, which is what makes "your pin is wrong" fixable.
      expect(C.pinFreezeReason({ spotStatus: S.REJECTED, ownerApproved: true })).toBeNull();
      expect(C.pinFreezeReason({ spotStatus: S.NOT_STARTED, ownerApproved: true })).toBeNull();
    });
  });

  test('the owner is given the promise and the time left', () => {
    const out = on(() => Policy.ownerSummary(
      { id: 1, spot_verification_status: S.DESK_PENDING, latitude: 12.9, longitude: 77.5 },
      { status: S.DESK_PENDING, submitted_at: new Date(Date.now() - 3600 * 1000) }
    ));

    expect(out.gate_enforced).toBe(true);
    expect(out.is_live).toBe(false);
    expect(out.promised_hours).toBe(48);
    expect(out.hours_left).toBeGreaterThan(46);
    expect(out.message).toMatch(/Under review/);
  });
});

describe('a grandfathered spot is unaffected either way', () => {
  test('visible with the gate on and with it off', () => {
    expect(on(() => C.isVisibleToDrivers(S.GRANDFATHERED))).toBe(true);
    expect(off(() => C.isVisibleToDrivers(S.GRANDFATHERED))).toBe(true);
  });

  test('and still reads as grandfathered, not as approved', () => {
    // Writing `approved` on these would record a check nobody performed,
    // which is the one thing the feature exists to stop. The flag does not
    // change that in either direction.
    for (const run of [on, off]) {
      expect(run(() => Policy.driverVisibleStatusFor({
        status: S.IN_PROGRESS, grandfathered_at: new Date(),
      }))).toBe(S.GRANDFATHERED);
    }
  });
});

/**
 * THE FLAG IS READ IN ONE PLACE.
 *
 * Asserted by reading the source, because it is a structural property that no
 * behavioural test can catch: a second `process.env.SPOT_VERIFICATION_GATE`
 * somewhere else would pass every test above and still be a second place to
 * drift out of step.
 */
describe('one read point', () => {
  const SRC = path.join(__dirname, '../../src');

  function filesUnder(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === 'generated' ? [] : filesUnder(p);
      return e.name.endsWith('.js') ? [p] : [];
    });
  }

  test('only constants/spotVerification.js looks at the variable', () => {
    const offenders = filesUnder(SRC)
      .filter((f) => fs.readFileSync(f, 'utf8').includes('SPOT_VERIFICATION_GATE'))
      .map((f) => path.relative(SRC, f))
      // env.js prints the state at boot through isSpotGateEnabled; it names
      // the variable only via the exported GATE_VARIABLE constant.
      .filter((f) => f !== 'constants/spotVerification.js' && f !== 'config/env.js');

    expect(offenders).toEqual([]);
  });

  test('config/env.js reports the state without reading process.env itself', () => {
    const src = fs.readFileSync(path.join(SRC, 'config/env.js'), 'utf8');
    expect(src).toContain('isSpotGateEnabled');
    expect(src).not.toMatch(/process\.env\.SPOT_VERIFICATION_GATE/);
    expect(src).not.toMatch(/process\.env\[['"]SPOT_VERIFICATION_GATE/);
  });

  test('nothing re-implements the visibility list outside the constants module', () => {
    // Every gate asks driverVisibilityWhere / driverVisibilitySql /
    // isVisibleToDrivers rather than filtering on the list itself, so there is
    // one definition of what a driver may see.
    const offenders = filesUnder(SRC)
      .filter((f) => fs.readFileSync(f, 'utf8').includes('VISIBLE_SPOT_STATUSES'))
      .map((f) => path.relative(SRC, f))
      .filter((f) => f !== 'constants/spotVerification.js' && f !== 'services/SpotVerificationPolicy.js');

    expect(offenders).toEqual([]);
  });
});
