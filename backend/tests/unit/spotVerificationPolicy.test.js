/**
 * The 48-hour promise, and what a driver may see.
 *
 * Both are pure functions with no database and no clock of their own, so they
 * can be pinned exhaustively here: every status, both sides of each boundary,
 * and the one case the whole backfill turns on — a spot that was already live
 * must not disappear while its own review is in flight.
 *
 *   npx jest tests/unit/spotVerificationPolicy.test.js
 */
const Policy = require('../../src/services/SpotVerificationPolicy');
const {
  SPOT_VERIFICATION_STATUS: S,
  ALL_SPOT_VERIFICATION_STATUSES,
  isVisibleToDrivers,
  isPinFrozen,
} = require('../../src/constants/spotVerification');

const NOW = new Date('2026-11-14T12:00:00.000Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600 * 1000);

describe('the clock runs from submission, through both stages', () => {
  test('a fresh submission is ok, with the full promise left', () => {
    const w = Policy.waitFor({ status: S.DESK_PENDING, submittedAt: NOW, now: NOW });

    expect(w.sla).toBe('ok');
    expect(w.waiting_hours).toBe(0);
    expect(w.hours_left).toBe(48);
    expect(w.overdue_by_hours).toBeNull();
  });

  test('it keeps running after the desk passes — a desk pass is not live', () => {
    // The owner was promised a LIVE spot in 48 hours, and desk_approved is not
    // visible to anyone. Stopping the clock here would hide every breach in
    // the stage we control least.
    const w = Policy.waitFor({ status: S.DESK_APPROVED, submittedAt: hoursAgo(40), now: NOW });

    expect(w.sla).toBe('at_risk');
    expect(w.waiting_hours).toBe(40);
  });

  const boundaries = [
    [0, 'ok'], [12, 'ok'], [35.9, 'ok'],
    [36, 'at_risk'], [36.1, 'at_risk'], [47.9, 'at_risk'],
    [48, 'overdue'], [60, 'overdue'], [1000, 'overdue'],
  ];

  test.each(boundaries)('%s hours waiting is %s', (hours, expected) => {
    expect(Policy.waitFor({ status: S.DESK_PENDING, submittedAt: hoursAgo(hours), now: NOW }).sla)
      .toBe(expected);
  });

  test('the boundaries are inclusive, because rounding a promise down is how it breaks', () => {
    expect(Policy.waitFor({ status: S.DESK_PENDING, submittedAt: hoursAgo(36), now: NOW }).sla).toBe('at_risk');
    expect(Policy.waitFor({ status: S.DESK_PENDING, submittedAt: hoursAgo(48), now: NOW }).sla).toBe('overdue');
  });

  test('hours_left never goes negative; overdue_by_hours says how far past', () => {
    const w = Policy.waitFor({ status: S.DESK_PENDING, submittedAt: hoursAgo(50.5), now: NOW });

    expect(w.hours_left).toBe(0);
    expect(w.overdue_by_hours).toBe(2.5);
  });

  const notWaiting = [S.NOT_STARTED, S.IN_PROGRESS, S.APPROVED, S.REJECTED, S.GRANDFATHERED];

  test.each(notWaiting)('%s is not waiting on us, so there is no clock', (status) => {
    const w = Policy.waitFor({ status, submittedAt: hoursAgo(500), now: NOW });

    expect(w.sla).toBe('not_waiting');
    expect(w.waiting_hours).toBeNull();
    expect(w.hours_left).toBeNull();
  });

  test('a grandfathered spot is never overdue, even with a submission in flight', () => {
    // Nobody promised these owners 48 hours. Counting them would open the
    // feature with a queue full of breaches that mean nothing.
    expect(Policy.waitFor({ status: S.GRANDFATHERED, submittedAt: hoursAgo(300), now: NOW }).sla)
      .toBe('not_waiting');
  });

  test('a submission with no timestamp is not a breach', () => {
    expect(Policy.waitFor({ status: S.DESK_PENDING, submittedAt: null, now: NOW }).sla).toBe('not_waiting');
    expect(Policy.waitFor({ status: S.DESK_PENDING, submittedAt: 'not a date', now: NOW }).sla).toBe('not_waiting');
  });

  test('a submitted_at in the future is a clock disagreeing, not negative patience', () => {
    const w = Policy.waitFor({ status: S.DESK_PENDING, submittedAt: new Date(NOW.getTime() + 3600_000), now: NOW });

    expect(w.waiting_hours).toBe(0);
    expect(w.sla).toBe('ok');
  });

  test('every status is accounted for', () => {
    // A new status added without a decision about the clock fails here rather
    // than quietly behaving like "not waiting".
    for (const status of ALL_SPOT_VERIFICATION_STATUSES) {
      const w = Policy.waitFor({ status, submittedAt: hoursAgo(1), now: NOW });
      expect(['ok', 'at_risk', 'overdue', 'not_waiting']).toContain(w.sla);
    }
  });
});

/**
 * What a driver may see. This is the function that keeps the backfill's
 * promise, so it gets its own exhaustive table.
 */
describe('driverVisibleStatusFor', () => {
  test('a new spot shows its own status, so it stays hidden until approved', () => {
    for (const status of [S.NOT_STARTED, S.IN_PROGRESS, S.DESK_PENDING, S.DESK_APPROVED]) {
      const visible = Policy.driverVisibleStatusFor({ status, grandfathered_at: null });
      expect(visible).toBe(status);
      expect(isVisibleToDrivers(visible)).toBe(false);
    }
  });

  test('approved is visible; rejected is not', () => {
    expect(isVisibleToDrivers(Policy.driverVisibleStatusFor({ status: S.APPROVED }))).toBe(true);
    expect(isVisibleToDrivers(Policy.driverVisibleStatusFor({ status: S.REJECTED }))).toBe(false);
  });

  const inFlight = [S.NOT_STARTED, S.IN_PROGRESS, S.DESK_PENDING, S.DESK_APPROVED, S.GRANDFATHERED];

  test.each(inFlight)('a grandfathered spot stays visible while its record is %s', (status) => {
    // The promise: a spot that was live when this shipped does not vanish as a
    // reward for doing what we asked.
    const visible = Policy.driverVisibleStatusFor({ status, grandfathered_at: new Date() });

    expect(visible).toBe(S.GRANDFATHERED);
    expect(isVisibleToDrivers(visible)).toBe(true);
  });

  test('a verdict beats grandfathering, in both directions', () => {
    expect(Policy.driverVisibleStatusFor({ status: S.APPROVED, grandfathered_at: new Date() })).toBe(S.APPROVED);
    // Rejected means it leaves the finder — not silently: the owner is shown
    // the reason.
    expect(Policy.driverVisibleStatusFor({ status: S.REJECTED, grandfathered_at: new Date() })).toBe(S.REJECTED);
  });
});

describe('the pin is fixed while a spot is live or under review', () => {
  test.each([S.APPROVED, S.GRANDFATHERED])('%s is live, so the pin is fixed', (status) => {
    expect(isPinFrozen(status)).toBe(true);
  });

  test.each([S.DESK_PENDING, S.DESK_APPROVED])('%s is under review, so the pin is fixed', (status) => {
    // The desk check measures the document's address against this pin.
    expect(isPinFrozen(status)).toBe(true);
  });

  test.each([S.NOT_STARTED, S.IN_PROGRESS, S.REJECTED, null, undefined])('%s leaves the pin free', (status) => {
    expect(isPinFrozen(status)).toBe(false);
  });
});

describe('what the owner is told', () => {
  const message = (status, submittedAt = null) =>
    Policy.ownerMessageFor({ status, submittedAt, now: NOW });

  test('an unsubmitted spot is told it is not visible and what to do', () => {
    expect(message(S.NOT_STARTED)).toMatch(/document/i);
    expect(message(S.NOT_STARTED)).toMatch(/cannot see it/i);
  });

  test('a spot under review is given the time it has left', () => {
    expect(message(S.DESK_PENDING, hoursAgo(10))).toMatch(/Expected live within 38 hour/);
  });

  test('past the promise it says so, instead of counting down from a missed deadline', () => {
    const m = message(S.DESK_PENDING, hoursAgo(60));

    expect(m).toMatch(/longer than the 48 hours we promised/);
    expect(m).not.toMatch(/-/);
  });

  test('a grandfathered spot is told the truth: live, not yet checked', () => {
    const m = message(S.GRANDFATHERED);

    expect(m).toMatch(/Live on ParkStop/);
    expect(m).toMatch(/still need to check/i);
    // It must never claim to be verified.
    expect(m).not.toMatch(/verified/i);
  });

  test('an approved spot says drivers can book it', () => {
    expect(message(S.APPROVED)).toMatch(/Verified/);
  });

  test('every status has a sentence of its own', () => {
    const seen = new Set();
    for (const status of ALL_SPOT_VERIFICATION_STATUSES) {
      const m = message(status, hoursAgo(1));
      expect(typeof m).toBe('string');
      expect(m.length).toBeGreaterThan(10);
      seen.add(m);
    }
    // desk_pending and desk_approved deliberately share one sentence: the
    // owner does not care which of our two stages it is sitting in.
    expect(seen.size).toBe(ALL_SPOT_VERIFICATION_STATUSES.length - 1);
  });
});

describe('ownerSummary is the one shape both owner screens read', () => {
  const spot = { id: 5, title: 'Front driveway', spot_verification_status: S.DESK_PENDING };

  test('it carries the state, the clock and the promise', () => {
    const out = Policy.ownerSummary(
      spot,
      {
        status: S.DESK_PENDING,
        submitted_at: hoursAgo(37),
        doc_public_id: 'parkstop/spot-docs/abc',
        doc_type: 'electricity_bill',
        claimed_address: '1 Test St',
        relationship: 'owner',
      },
      NOW
    );

    expect(out).toMatchObject({
      spot_id: 5,
      title: 'Front driveway',
      status: S.DESK_PENDING,
      visible_to_drivers: S.DESK_PENDING,
      is_live: false,
      waiting_hours: 37,
      hours_left: 11,
      promised_hours: 48,
      pin_locked: true,
    });
    expect(out.document).toEqual({ doc_type: 'electricity_bill', address: '1 Test St', relationship: 'owner' });
  });

  test('a grandfathered spot reads as live while its review is in flight', () => {
    const out = Policy.ownerSummary(
      { id: 6, title: 'Live bay', spot_verification_status: S.GRANDFATHERED },
      { status: S.DESK_PENDING, submitted_at: hoursAgo(1), grandfathered_at: hoursAgo(100) },
      NOW
    );

    expect(out.is_live).toBe(true);
    expect(out.visible_to_drivers).toBe(S.GRANDFATHERED);
    // Its own paperwork is still in review, and the clock is honest about it.
    expect(out.status).toBe(S.DESK_PENDING);
    expect(out.waiting_hours).toBe(1);
  });

  test('a rejection reason is only shown when the spot is rejected', () => {
    const rejected = Policy.ownerSummary(
      { id: 7, spot_verification_status: S.REJECTED },
      { status: S.REJECTED, rejection_reason: 'The bill is for a different street.' },
      NOW
    );
    expect(rejected.rejection_reason).toBe('The bill is for a different street.');

    const approved = Policy.ownerSummary(
      { id: 7, spot_verification_status: S.APPROVED },
      { status: S.APPROVED, rejection_reason: 'stale text from last time' },
      NOW
    );
    expect(approved.rejection_reason).toBeNull();
  });

  test('it never leaks the document id', () => {
    const out = Policy.ownerSummary(
      { id: 8, spot_verification_status: S.IN_PROGRESS },
      { status: S.IN_PROGRESS, doc_public_id: 'parkstop/spot-docs/secret123', doc_type: 'water_bill' },
      NOW
    );

    expect(JSON.stringify(out)).not.toMatch(/secret123/);
  });

  test('a spot with no record at all still answers', () => {
    // Defensive: every spot gets a record at create time and the backfill gave
    // one to every existing spot, but a summary that throws would take the
    // whole dashboard down with it.
    const out = Policy.ownerSummary({ id: 9, spot_verification_status: S.NOT_STARTED }, null, NOW);

    expect(out.status).toBe(S.NOT_STARTED);
    expect(out.is_live).toBe(false);
  });
});
