/**
 * The money rules, checked arithmetically. No database, no gateway.
 *
 * The worked examples in the spec are reproduced here as tests, so if the
 * numbers in the app ever stop matching the numbers you agreed, one of these
 * fails.
 */
const P = require('../../src/services/BookingRefundPolicy');

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const NOW = new Date('2026-08-17T10:00:00Z');
const at = (ms) => new Date(NOW.getTime() + ms);

describe('advance fee', () => {
  test('applies from two hours of lead onwards', () => {
    expect(P.advanceFeeFor(at(2 * HOUR), NOW)).toBe(50);
    expect(P.advanceFeeFor(at(5 * HOUR), NOW)).toBe(50);
  });

  test('does not apply just under the threshold', () => {
    expect(P.advanceFeeFor(at(2 * HOUR - MIN), NOW)).toBe(0);
    expect(P.advanceFeeFor(NOW, NOW)).toBe(0);
  });

  test('never applies to cash, which is settled in person', () => {
    expect(P.advanceFeeFor(at(5 * HOUR), NOW, 'cash')).toBe(0);
  });
});

describe('how far ahead each mode may book', () => {
  test('book-now is fine in both modes', () => {
    expect(P.validateLeadTime(NOW, NOW, 'online').ok).toBe(true);
    expect(P.validateLeadTime(NOW, NOW, 'cash').ok).toBe(true);
  });

  test('a fast device clock is tolerated, not treated as scheduling', () => {
    expect(P.validateLeadTime(at(10 * MIN), NOW, 'cash').ok).toBe(true);
  });

  test('cash cannot be booked beyond an hour ahead', () => {
    const v = P.validateLeadTime(at(3 * HOUR), NOW, 'cash');
    expect(v.ok).toBe(false);
    // The message has to tell them what to do instead, not just say no.
    expect(v.reason).toMatch(/online/i);
  });

  test('online can be booked days ahead', () => {
    expect(P.validateLeadTime(at(48 * HOUR), NOW, 'online').ok).toBe(true);
  });

  test('online still has a ceiling', () => {
    expect(P.validateLeadTime(at(30 * 24 * HOUR), NOW, 'online').ok).toBe(false);
  });
});

describe('refund ladder', () => {
  const start = at(4 * HOUR);

  test('cancelling early returns 70% of the spot fee', () => {
    const r = P.refundFor({ spotFee: 400, advanceFee: 50, startTime: start, now: NOW });
    expect(r.tier).toBe('early_cancel');
    expect(r.refundAmount).toBe(280);
    expect(r.withheldAmount).toBe(170); // 120 held back + the 50 fee
    expect(r.requiresClaim).toBe(false);
  });

  test('cancelling inside the last half hour drops to 50%', () => {
    const r = P.refundFor({
      spotFee: 400, advanceFee: 50, startTime: start, now: at(4 * HOUR - 10 * MIN),
    });
    expect(r.tier).toBe('late_cancel');
    expect(r.refundAmount).toBe(200);
  });

  test('exactly 30 minutes out is still the early tier', () => {
    const r = P.refundFor({
      spotFee: 400, startTime: start, now: at(4 * HOUR - 31 * MIN),
    });
    expect(r.tier).toBe('early_cancel');
  });

  test('a no-show gets 50% but has to ask for it', () => {
    const r = P.refundFor({
      spotFee: 400, advanceFee: 50, startTime: start,
      now: at(4 * HOUR + 45 * MIN), reason: 'no_show',
    });
    expect(r.tier).toBe('no_show');
    expect(r.refundAmount).toBe(200);
    expect(r.requiresClaim).toBe(true);
  });

  test('the advance fee is never part of what comes back', () => {
    const withFee = P.refundFor({ spotFee: 400, advanceFee: 50, startTime: start, now: NOW });
    const without = P.refundFor({ spotFee: 400, advanceFee: 0, startTime: start, now: NOW });
    expect(withFee.refundAmount).toBe(without.refundAmount);
  });
});

describe('who gets the money that is not refunded', () => {
  test('early cancellation of a 400 booking booked 3h ahead', () => {
    // Spec worked example: owner 121, platform 49.
    const s = P.settlementFor({
      spotFeeTotal: 400, spotFeeWithheld: 120, advanceFee: 50, locationType: 'urban',
    });
    expect(s.ownerAmount).toBe(121);
    expect(s.platformAmount).toBe(49);
  });

  test('no-show on the same booking', () => {
    // Spec worked example: owner 185, platform 65.
    const s = P.settlementFor({
      spotFeeTotal: 400, spotFeeWithheld: 200, advanceFee: 50, locationType: 'urban',
    });
    expect(s.ownerAmount).toBe(185);
    expect(s.platformAmount).toBe(65);
  });

  test('nothing is created or destroyed in the split', () => {
    const s = P.settlementFor({
      spotFeeTotal: 500, spotFeeWithheld: 137.5, advanceFee: 50, locationType: 'urban',
    });
    expect(s.ownerAmount + s.platformAmount).toBeCloseTo(187.5, 2);
  });

  test('the commission rate follows the booking, not the size of the refund', () => {
    // A 400 booking is a 20% booking. Withholding 120 must not slip into the
    // under-200 band and settle at 15%.
    const cancelled = P.settlementFor({ spotFeeTotal: 400, spotFeeWithheld: 120 });
    expect(cancelled.commissionRate).toBe(0.20);
    expect(cancelled.platformAmount).toBe(24);

    // ...and a high-value booking keeps its 30% rate on the withheld part.
    const premium = P.settlementFor({ spotFeeTotal: 2500, spotFeeWithheld: 750 });
    expect(premium.commissionRate).toBe(0.30);
    expect(premium.platformAmount).toBe(225);
  });
});

describe('prepaid amount is a floor, not a ceiling', () => {
  test('leaving early does not hand money back', () => {
    const c = P.finalChargeFor({ amountPaid: 400, actualCharge: 250 });
    expect(c.total).toBe(400);
    expect(c.outstanding).toBe(0);
  });

  test('overstaying is billed at checkout', () => {
    const c = P.finalChargeFor({ amountPaid: 400, actualCharge: 525 });
    expect(c.total).toBe(525);
    expect(c.outstanding).toBe(125);
  });

  test('an unpaid booking still bills the full actual amount', () => {
    const c = P.finalChargeFor({ amountPaid: 0, actualCharge: 300 });
    expect(c.total).toBe(300);
    expect(c.outstanding).toBe(300);
  });
});
