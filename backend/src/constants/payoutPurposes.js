/**
 * What a row in the `payouts` table is for.
 *
 * Every owner credit writes one of these. They are split into two groups
 * because the two are counted differently: a BOOKING purpose is earnings from
 * a completed session, which the booking row already records in
 * spotter_earning, and a SETTLEMENT purpose is the owner's share of money
 * withheld from a booking that never happened -- a cancellation or a no-show.
 *
 * A settlement has no completed booking behind it, so anything that totals a
 * host's earnings from the bookings table alone misses it entirely. That was
 * how a no-show credit could land in an owner's wallet while their "Earned so
 * far" stayed put. Count both, and only ever through these constants, so the
 * dashboard, the trend and the earnings list cannot drift apart again.
 */

/** Earnings from a session that actually ran. */
const BOOKING_PURPOSE = 'payout';

/** The owner's share of money withheld when a booking fell through. */
const NO_SHOW_SETTLEMENT = 'no_show_settlement';
const CANCELLATION_SETTLEMENT = 'cancellation_settlement';

const SETTLEMENT_PURPOSES = [NO_SHOW_SETTLEMENT, CANCELLATION_SETTLEMENT];

/** How each settlement reads on an earnings line. */
const SETTLEMENT_LABELS = {
  [NO_SHOW_SETTLEMENT]: 'Driver did not arrive',
  [CANCELLATION_SETTLEMENT]: 'Booking cancelled',
};

module.exports = {
  BOOKING_PURPOSE,
  NO_SHOW_SETTLEMENT,
  CANCELLATION_SETTLEMENT,
  SETTLEMENT_PURPOSES,
  SETTLEMENT_LABELS,
};
