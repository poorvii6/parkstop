/**
 * Booking money policy — pure functions, no database, no gateway.
 *
 * Everything here is arithmetic on numbers and dates so it can be tested
 * exhaustively. The service that actually moves money (BookingRefundService)
 * calls into this and does nothing clever of its own — if a refund is ever
 * wrong, the bug is in one of these functions and there is a test for it.
 *
 * The rules, as agreed:
 *
 *   - Online bookings are paid in full at booking time.
 *   - A start time 2 hours or more away adds a flat advance fee, split evenly
 *     between the owner and the platform. It compensates the owner for a bay
 *     held out of circulation, and it is never refunded.
 *   - Cash bookings are paid at the spot and cannot be booked more than an hour
 *     ahead, so they never attract the advance fee.
 *   - Cancel more than 30 minutes before the start: 70% of the spot fee back.
 *   - Cancel inside that last 30 minutes: 50%.
 *   - Fail to arrive within 30 minutes of the start: 50%, and only if claimed.
 *   - Whatever is withheld settles like ordinary revenue — the owner takes
 *     their commission share, the platform takes its own.
 */

const CommissionService = require('./CommissionService');

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Flat fee added when a booking is made well ahead of its start time. */
const ADVANCE_FEE = num(process.env.ADVANCE_BOOKING_FEE, 50);

/** Lead time at or beyond which the advance fee applies. */
const ADVANCE_FEE_THRESHOLD_MS = num(process.env.ADVANCE_FEE_THRESHOLD_HOURS, 2) * HOUR_MS;

/** The owner's share of the advance fee; the platform keeps the remainder. */
const ADVANCE_FEE_OWNER_SHARE = num(process.env.ADVANCE_FEE_OWNER_SHARE, 0.5);

/** How late a finder may arrive before the bay is released. */
const GRACE_MS = num(process.env.ARRIVAL_GRACE_MINUTES, 30) * MINUTE_MS;

/** Cancelling before this point in the run-up gets the higher refund. */
const LATE_CANCEL_WINDOW_MS = num(process.env.LATE_CANCEL_WINDOW_MINUTES, 30) * MINUTE_MS;

const EARLY_CANCEL_REFUND_RATE = num(process.env.EARLY_CANCEL_REFUND_RATE, 0.7);
const LATE_CANCEL_REFUND_RATE = num(process.env.LATE_CANCEL_REFUND_RATE, 0.5);
const NO_SHOW_REFUND_RATE = num(process.env.NO_SHOW_REFUND_RATE, 0.5);

/**
 * How far ahead each payment mode may be booked.
 *
 * Cash is capped tightly because the money is collected in person: a cash
 * booking made for next week would hold a bay for a week against nothing but a
 * promise. Online bookings are prepaid, so the finder has real skin in the
 * game and the ceiling can be generous.
 */
const MAX_LEAD_MS = {
  online: num(process.env.MAX_ONLINE_LEAD_HOURS, 168) * HOUR_MS, // 7 days
  cash: num(process.env.MAX_CASH_LEAD_HOURS, 1) * HOUR_MS,
};

/**
 * Small allowance so a device whose clock runs fast is not refused. Applies to
 * both modes and is not scheduling — it is slack around "now".
 */
const CLOCK_SKEW_ALLOWANCE_MS = 15 * MINUTE_MS;

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * The advance fee for a booking, or 0 if it does not qualify.
 *
 * @param {Date|string|number} startTime  when the finder intends to arrive
 * @param {Date|string|number} now
 * @param {string} paymentMode  'online' | 'cash'
 */
function advanceFeeFor(startTime, now, paymentMode = 'online') {
  // Cash is settled in person and capped at an hour's lead, so it can never
  // reach the threshold. Guarding explicitly keeps that true even if the cap
  // is later loosened by configuration.
  if (paymentMode === 'cash') return 0;

  const leadMs = new Date(startTime).getTime() - new Date(now).getTime();
  return leadMs >= ADVANCE_FEE_THRESHOLD_MS ? ADVANCE_FEE : 0;
}

/**
 * Whether a booking may be created at all, given how far ahead it starts.
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function validateLeadTime(startTime, now, paymentMode = 'online') {
  const mode = paymentMode === 'cash' ? 'cash' : 'online';
  const leadMs = new Date(startTime).getTime() - new Date(now).getTime();

  if (leadMs <= CLOCK_SKEW_ALLOWANCE_MS) return { ok: true };

  if (leadMs > MAX_LEAD_MS[mode]) {
    return {
      ok: false,
      reason:
        mode === 'cash'
          ? 'Pay-at-spot bookings can only be made up to an hour ahead. Choose online payment to book further in advance.'
          : 'That start time is too far ahead to book.',
    };
  }

  return { ok: true };
}

/**
 * What a finder gets back, and what is withheld.
 *
 * @param {object} args
 * @param {number} args.spotFee     what they paid for the parking itself
 * @param {number} args.advanceFee  the flat fee, if any — never refunded
 * @param {Date|string|number} args.startTime
 * @param {Date|string|number} args.now
 * @param {'finder_cancelled'|'no_show'} args.reason
 *
 * @returns {{tier: string, refundAmount: number, withheldAmount: number,
 *            requiresClaim: boolean, refundRate: number}}
 */
function refundFor({ spotFee, advanceFee = 0, startTime, now, reason = 'finder_cancelled' }) {
  const fee = Math.max(0, Number(spotFee) || 0);
  const start = new Date(startTime).getTime();
  const at = new Date(now).getTime();

  let tier;
  let rate;
  let requiresClaim = false;

  if (reason === 'no_show') {
    // The bay sat empty and the owner waited. Same rate as a late cancellation,
    // but the finder has to ask for it — we do not push money at someone who
    // simply vanished.
    tier = 'no_show';
    rate = NO_SHOW_REFUND_RATE;
    requiresClaim = true;
  } else if (at < start - LATE_CANCEL_WINDOW_MS) {
    tier = 'early_cancel';
    rate = EARLY_CANCEL_REFUND_RATE;
  } else {
    // Inside the last half hour the owner has effectively committed the bay,
    // so cancelling costs the same as not turning up.
    tier = 'late_cancel';
    rate = LATE_CANCEL_REFUND_RATE;
  }

  const refundAmount = round2(fee * rate);

  return {
    tier,
    refundRate: rate,
    refundAmount,
    // The advance fee is deliberately outside the refund but inside the
    // withheld total, because it still has to be paid out to someone.
    withheldAmount: round2(fee - refundAmount + (Number(advanceFee) || 0)),
    requiresClaim,
  };
}

/**
 * Split the money nobody is getting back between the owner and the platform.
 *
 * The advance fee splits by its own fixed ratio. The withheld part of the spot
 * fee is not a special category — it settles exactly like revenue from a
 * completed booking, so the owner's share is whatever commission they would
 * normally have earned. That keeps one rule instead of two.
 *
 * Note which number sets the rate. CommissionService is price-tiered (15% under
 * ₹200, 30% over ₹2000), so feeding it the WITHHELD amount would let the rate
 * drift with the size of the refund: a ₹400 booking withholding ₹120 would land
 * in the under-₹200 band and settle at 15%, better than the 20% the booking was
 * actually agreed at — and a ₹2500 booking withholding ₹750 would settle at 20%
 * instead of 30%. The rate belongs to the booking; only the amount it is
 * applied to changes.
 *
 * @param {number} args.spotFeeTotal    the booking's full spot fee — sets the rate
 * @param {number} args.spotFeeWithheld the part not being refunded — what the rate is applied to
 */
function settlementFor({ spotFeeTotal, spotFeeWithheld, advanceFee = 0, locationType = 'urban' }) {
  const withheld = Math.max(0, Number(spotFeeWithheld) || 0);
  const fee = Math.max(0, Number(advanceFee) || 0);
  // Fall back to the withheld amount only when the caller has no total to give,
  // so old call sites degrade to the previous behaviour rather than to zero.
  const basis = Math.max(0, Number(spotFeeTotal) || withheld);

  const { commissionRate } = CommissionService.calculateCommission(basis, locationType);

  const platformShare = round2(withheld * commissionRate);
  const ownerShare = round2(withheld - platformShare);
  const advanceToOwner = round2(fee * ADVANCE_FEE_OWNER_SHARE);

  return {
    commissionRate,
    ownerAmount: round2(ownerShare + advanceToOwner),
    platformAmount: round2(platformShare + (fee - advanceToOwner)),
  };
}

/**
 * What to charge when a session ends.
 *
 * A prepaid booking is a floor, never a ceiling: leaving early does not earn a
 * refund, but overstaying is billed. Booking.complete() previously recomputed
 * the price purely from time elapsed and overwrote whatever had been paid,
 * which for a prepaid booking would quietly hand money back to a finder who
 * left early.
 */
function finalChargeFor({ amountPaid = 0, actualCharge = 0 }) {
  const paid = Math.max(0, Number(amountPaid) || 0);
  const actual = Math.max(0, Number(actualCharge) || 0);

  return {
    total: round2(Math.max(paid, actual)),
    // Anything above the prepaid floor still has to be collected at checkout.
    outstanding: round2(Math.max(0, actual - paid)),
  };
}

module.exports = {
  advanceFeeFor,
  validateLeadTime,
  refundFor,
  settlementFor,
  finalChargeFor,
  ADVANCE_FEE,
  GRACE_MS,
  MAX_LEAD_MS,
  CLOCK_SKEW_ALLOWANCE_MS,
};
