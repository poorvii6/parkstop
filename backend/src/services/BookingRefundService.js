/**
 * Moves the money that BookingRefundPolicy decides.
 *
 * This service deliberately contains no arithmetic of its own — every figure
 * comes from the policy module, which is pure and exhaustively tested. What
 * lives here is the ordering and the safety: claim the booking before calling
 * the gateway, credit the owner in the same transaction that records the
 * refund, and never let a retry pay twice.
 *
 * The idempotency rule matters more than anything else in this file. A refund
 * that runs twice is money out of the business with no way to get it back, and
 * refunds are exactly the code path people retry — a timeout, a double tap, a
 * queue redelivery.
 */

const prisma = require('../config/prisma');
const logger = require('../utils/logger');
const PaymentService = require('./paymentService');
const Policy = require('./BookingRefundPolicy');

/** Statuses from which no further refund may be started. */
const TERMINAL_REFUND_STATUSES = ['processing', 'processed'];

/**
 * Work out what a booking is owed without changing anything.
 *
 * Exposed so the app can show "you'll get ₹280 back" on the confirm dialog
 * using the same code that will later actually pay it — rather than a second
 * implementation in the frontend that drifts.
 */
function quote(booking, { reason = 'finder_cancelled', now = new Date() } = {}) {
  const spotFee = Number(booking.amount_paid) - Number(booking.advance_fee || 0);

  return Policy.refundFor({
    // Only money actually collected can come back. For a cash booking nothing
    // was banked, so the whole ladder resolves to zero — correctly.
    spotFee: Math.max(0, spotFee),
    advanceFee: Number(booking.advance_fee) || 0,
    startTime: booking.start_time,
    now,
    reason,
  });
}

/**
 * Reserve the right to refund this booking.
 *
 * Flips refund_status to 'processing' only if it is not already in a terminal
 * state, so of two concurrent callers exactly one proceeds. Everything after
 * this point is safe to do exactly once.
 *
 * @returns {Promise<boolean>} whether this caller won the claim
 */
async function claimForRefund(bookingId, amount, reason) {
  const claimed = await prisma.bookings.updateMany({
    where: {
      id: parseInt(bookingId),
      OR: [{ refund_status: null }, { refund_status: { notIn: TERMINAL_REFUND_STATUSES } }],
    },
    data: {
      refund_status: 'processing',
      refund_amount: amount,
      cancellation_reason: reason,
      updated_at: new Date(),
    },
  });

  return claimed.count === 1;
}

/**
 * Pay the owner and the platform their share of whatever was not refunded.
 *
 * Runs in the caller's transaction so the credit and the booking record move
 * together — a crash between them would otherwise leave an owner paid for a
 * refund that never happened, or a refund with nobody credited.
 */
async function settleWithheld(tx, { booking, spot, withheldSpotFee }) {
  const settlement = Policy.settlementFor({
    // The rate belongs to the booking, not to the fraction being settled.
    spotFeeTotal: Number(booking.amount_paid) - Number(booking.advance_fee || 0),
    spotFeeWithheld: withheldSpotFee,
    advanceFee: Number(booking.advance_fee) || 0,
    locationType: spot?.location_type || 'urban',
  });

  if (spot?.spotter_id && settlement.ownerAmount > 0) {
    await tx.users.update({
      where: { id: spot.spotter_id },
      data: { balance: { increment: settlement.ownerAmount } },
    });
  }

  return settlement;
}

/**
 * Refund a booking according to the ladder, and settle what is withheld.
 *
 * @param {object} booking  must include amount_paid, advance_fee, start_time, payment_id
 * @param {object} spot     the parking spot, for the owner id and location type
 * @param {object} opts
 * @param {'finder_cancelled'|'no_show'} opts.reason
 * @param {boolean} opts.force  process even if the ladder says it needs a claim
 */
async function refundBooking(booking, spot, { reason = 'finder_cancelled', force = false, now = new Date() } = {}) {
  const q = quote(booking, { reason, now });

  // A no-show refund is deliberately not automatic — the finder has to ask. The
  // sweep marks it claimable and stops; only the claim endpoint passes force.
  if (q.requiresClaim && !force) {
    await prisma.bookings.update({
      where: { id: parseInt(booking.id) },
      data: {
        refund_status: 'claimable',
        refund_amount: q.refundAmount,
        cancellation_reason: reason,
        updated_at: new Date(),
      },
    });
    return { ...q, status: 'claimable', refunded: false };
  }

  const won = await claimForRefund(booking.id, q.refundAmount, reason);
  if (!won) {
    logger.info(`Refund for booking ${booking.id} already in flight or done; skipping`);
    return { ...q, status: 'already_handled', refunded: false };
  }

  const withheldSpotFee = Math.max(
    0,
    Number(booking.amount_paid) - Number(booking.advance_fee || 0) - q.refundAmount
  );

  let refundId = null;
  if (q.refundAmount > 0) {
    try {
      refundId = await PaymentService.processRefund(booking.id, q.refundAmount);
    } catch (err) {
      // Hand it back so a human or a retry can pick it up. Leaving it at
      // 'processing' would strand it forever behind the idempotency guard.
      logger.error(`Gateway refund failed for booking ${booking.id}:`, err);
      await prisma.bookings.update({
        where: { id: parseInt(booking.id) },
        data: { refund_status: 'failed', updated_at: new Date() },
      });
      return { ...q, status: 'failed', refunded: false, error: err.message };
    }
  }

  const settlement = await prisma.$transaction(async (tx) => {
    const s = await settleWithheld(tx, { booking, spot, withheldSpotFee });

    await tx.bookings.update({
      where: { id: parseInt(booking.id) },
      data: {
        refund_status: 'processed',
        refund_amount: q.refundAmount,
        refund_id: typeof refundId === 'string' ? refundId : null,
        refunded_at: new Date(),
        cancellation_reason: reason,
        updated_at: new Date(),
      },
    });

    return s;
  });

  logger.info(
    `Booking ${booking.id} refunded ₹${q.refundAmount} (${q.tier}); ` +
    `owner credited ₹${settlement.ownerAmount}, platform kept ₹${settlement.platformAmount}`
  );

  return { ...q, status: 'processed', refunded: true, settlement, refundId };
}

module.exports = {
  quote,
  refundBooking,
  claimForRefund,
  TERMINAL_REFUND_STATUSES,
};
