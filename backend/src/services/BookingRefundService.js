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
 *
 * Refund lifecycle (bookings.refund_status):
 *   null           nothing owed yet
 *   'claimable'    a no-show the finder may still claim
 *   'processing'   claimed; the gateway call is in flight
 *   'processed'    money returned
 *   'failed'       a network or 5xx error; retried by the sweep and by a claim
 *   'needs_review' Razorpay refused it (4xx) or the ledger does not add up;
 *                  never retried automatically — an admin has to look
 */

const prisma = require('../config/prisma');
const logger = require('../utils/logger');
const PaymentService = require('./paymentService');
const NotificationService = require('./notificationService');
const Policy = require('./BookingRefundPolicy');

/** Statuses from which no further refund may be started. */
const TERMINAL_REFUND_STATUSES = ['processing', 'processed', 'needs_review'];

/** A failed refund waits this long before the sweep tries it again. */
const RETRY_AFTER_MS = 15 * 60 * 1000;

/**
 * Work out what a booking is owed without changing anything.
 *
 * Exposed so the app can show "you'll get ₹280 back" on the confirm dialog
 * using the same code that will later actually pay it — rather than a second
 * implementation in the frontend that drifts.
 */
function quote(booking, { reason = 'finder_cancelled', now = new Date() } = {}) {
  return Policy.refundFor({
    // Only money actually collected can come back. For a cash booking nothing
    // was banked, so the whole ladder resolves to zero — correctly.
    spotFee: Math.max(0, spotFeeOf(booking)),
    advanceFee: Number(booking.advance_fee) || 0,
    startTime: booking.start_time,
    now,
    reason,
  });
}

function spotFeeOf(booking) {
  return Number(booking.amount_paid) - Number(booking.advance_fee || 0);
}

/**
 * Reserve the right to refund this booking.
 *
 * Flips refund_status to 'processing' only if it is not already in a terminal
 * state, so of two concurrent callers exactly one proceeds. Everything after
 * this point is safe to do exactly once.
 *
 * @param {object} [opts]
 * @param {string} [opts.onlyFrom]  additionally require this current status.
 *   A retry passes 'failed', so it can never pick up a row that is still
 *   claimable, or one a first attempt is about to write.
 * @returns {Promise<boolean>} whether this caller won the claim
 */
async function claimForRefund(bookingId, amount, reason, { onlyFrom } = {}) {
  const guard = { OR: [{ refund_status: null }, { refund_status: { notIn: TERMINAL_REFUND_STATUSES } }] };

  const claimed = await prisma.bookings.updateMany({
    where: {
      id: parseInt(bookingId),
      AND: onlyFrom ? [guard, { refund_status: onlyFrom }] : [guard],
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
 * Is this gateway error one that retrying will never fix?
 *
 * The Razorpay SDK rejects with { statusCode, error: { code, description } }.
 * A 4xx means Razorpay looked at the request and refused it — the payment is
 * already fully refunded, the amount is wrong, the payment is too old — and
 * asking again gets the same answer. Network errors (no status) and 5xx are
 * worth another go.
 *
 * 408 and 429 are 4xx in name only: a timeout and a rate limit. Both clear on
 * their own, so they are treated as temporary.
 */
function isPermanentGatewayError(err) {
  const status = Number(err?.statusCode ?? err?.status ?? err?.response?.status);
  if (!Number.isFinite(status)) return false;
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * Pay the owner and the platform their share of whatever was not refunded.
 *
 * Runs in the caller's transaction so the credit and the booking record move
 * together — a crash between them would otherwise leave an owner paid for a
 * refund that never happened, or a refund with nobody credited.
 */
async function settleWithheld(tx, { booking, spot, withheldSpotFee, reason }) {
  const settlement = Policy.settlementFor({
    // The rate belongs to the booking, not to the fraction being settled.
    spotFeeTotal: spotFeeOf(booking),
    spotFeeWithheld: withheldSpotFee,
    advanceFee: Number(booking.advance_fee) || 0,
    locationType: spot?.location_type || 'urban',
  });

  if (spot?.spotter_id && settlement.ownerAmount > 0) {
    // Record it, then credit it -- in that order, in this transaction.
    //
    // This used to move the balance and write nothing down. The owner saw
    // their wallet rise with no matching line in Earnings (which reads the
    // payouts table), and there was no trail on our side either: no way to
    // answer "where did this money come from", and nothing tying the credit
    // to the booking that produced it. Every other owner credit writes a row;
    // this one is the same money and now does too.
    const already = await tx.payouts.findFirst({ where: { booking_id: parseInt(booking.id) } });
    if (!already) {
      await tx.payouts.create({
        data: {
          user_id: spot.spotter_id,
          booking_id: parseInt(booking.id),
          amount: settlement.ownerAmount,
          status: 'balance_credited',
          mode: 'balance',
          purpose: reason === 'no_show' ? 'no_show_settlement' : 'cancellation_settlement',
          narration: reason === 'no_show'
            ? `ParkStop earnings - no-show on booking #${booking.id}`
            : `ParkStop earnings - cancelled booking #${booking.id}`,
        },
      });
      await tx.users.update({
        where: { id: spot.spotter_id },
        data: { balance: { increment: settlement.ownerAmount } },
      });
    }
  }

  return settlement;
}

/**
 * The refund is done (now, or by an earlier attempt that timed out): credit
 * the owner their share and mark the booking processed, together.
 */
async function recordProcessed(booking, spot, { amount, reason, refundId }) {
  const { withheldSpotFee } = Policy.withheldFor({
    spotFee: spotFeeOf(booking),
    advanceFee: Number(booking.advance_fee) || 0,
    refundAmount: amount,
  });

  const settlement = await prisma.$transaction(async (tx) => {
    const s = await settleWithheld(tx, { booking, spot, withheldSpotFee, reason });

    await tx.bookings.update({
      where: { id: parseInt(booking.id) },
      data: {
        refund_status: 'processed',
        refund_amount: amount,
        refund_id: typeof refundId === 'string' ? refundId : null,
        refunded_at: new Date(),
        cancellation_reason: reason,
        updated_at: new Date(),
      },
    });

    return s;
  });

  logger.info(
    `Booking ${booking.id} refunded ₹${amount} (${reason}); ` +
    `owner credited ₹${settlement.ownerAmount}, platform kept ₹${settlement.platformAmount}`
  );

  return settlement;
}

/** Tell every admin a refund needs a human. Never throws. */
async function notifyAdminsNeedsReview(booking, amount, why) {
  try {
    const admins = await prisma.users.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
    if (!admins.length) {
      logger.error(`Refund for booking ${booking.id} needs review but there is no admin account to tell`);
      return;
    }
    await Promise.all(admins.map((a) => NotificationService.sendPushNotification(a.id, {
      title: 'Refund needs review',
      body: `Booking #${booking.id}: ₹${amount} refund could not be paid automatically. ${why}`,
      data: { type: 'refund_needs_review', bookingId: parseInt(booking.id) },
    })));
  } catch (err) {
    logger.warn(`Admin refund-review notice failed for booking ${booking.id}: ${err?.message}`);
  }
}

/** Hand a booking to a human. It is never retried automatically after this. */
async function markNeedsReview(booking, amount, why) {
  logger.error(`Refund for booking ${booking.id} needs review: ${why}`);
  await prisma.bookings.update({
    where: { id: parseInt(booking.id) },
    data: { refund_status: 'needs_review', updated_at: new Date() },
  });
  await notifyAdminsNeedsReview(booking, amount, why);
}

/**
 * Leave the booking for the retry sweep. updated_at is what the sweep's
 * 15-minute wait is measured from, so it is always refreshed here.
 */
async function markFailed(booking) {
  await prisma.bookings.update({
    where: { id: parseInt(booking.id) },
    data: { refund_status: 'failed', updated_at: new Date() },
  });
}

/**
 * Call the gateway for a booking this caller has already claimed, then record
 * the outcome. Shared by the first attempt and by every retry.
 */
async function payClaimed(booking, spot, { amount, reason }) {
  let refundId = null;
  if (amount > 0) {
    try {
      refundId = await PaymentService.processRefund(booking.id, amount);
    } catch (err) {
      if (isPermanentGatewayError(err)) {
        const desc = err?.error?.description || err?.message || 'refused by Razorpay';
        await markNeedsReview(booking, amount, `Razorpay refused it: ${desc}`);
        return { status: 'needs_review', refunded: false, error: desc };
      }
      // Hand it back so the sweep or a claim can pick it up. Leaving it at
      // 'processing' would strand it forever behind the idempotency guard.
      logger.error(`Gateway refund failed for booking ${booking.id}:`, err);
      await markFailed(booking);
      return { status: 'failed', refunded: false, error: err?.message };
    }
  }

  const settlement = await recordProcessed(booking, spot, { amount, reason, refundId });
  return { status: 'processed', refunded: true, settlement, refundId };
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
  // A refund that already failed once has a figure on it. Re-quoting now could
  // pay a different one, so it goes down the retry path instead.
  if (booking.refund_status === 'failed') {
    return retryRefund(booking, spot, { notifyDriver: false });
  }

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

  const outcome = await payClaimed(booking, spot, { amount: q.refundAmount, reason });
  return { ...q, ...outcome };
}

/**
 * Try a 'failed' refund again.
 *
 * Two rules make this safe, and both have tests that fail if they are removed:
 *
 *  1. Ask Razorpay first. A refund call can time out after Razorpay has
 *     already accepted it. Calling refund again would pay it twice — and since
 *     Razorpay only stops a refund that exceeds what is left on the payment, a
 *     50% claim retried blindly goes through and returns 100%.
 *
 *  2. Pay the refund_amount already stored on the booking. Re-quoting later
 *     can move the booking to a worse tier, 70% down to 50%, and the finder
 *     was already told the first figure.
 *
 * @param {object} opts
 * @param {boolean} [opts.notifyDriver=true]  push the driver on success. The
 *   claim endpoint turns this off — the driver is looking at the answer.
 */
async function retryRefund(booking, spot, { notifyDriver = true } = {}) {
  const amount = Number(booking.refund_amount);
  const reason = booking.cancellation_reason || 'finder_cancelled';
  const { withheldAmount } = Policy.withheldFor({
    spotFee: spotFeeOf(booking),
    advanceFee: Number(booking.advance_fee) || 0,
    refundAmount: amount,
  });
  const base = { refundAmount: amount, withheldAmount, retried: true };

  if (!(amount > 0)) {
    // A failed refund with no figure on it should not exist. Do not invent one.
    const won = await claimForRefund(booking.id, booking.refund_amount, reason, { onlyFrom: 'failed' });
    if (!won) return { ...base, status: 'already_handled', refunded: false };
    await markNeedsReview(booking, 0, 'No refund amount is stored on the booking.');
    return { ...base, status: 'needs_review', refunded: false };
  }

  const won = await claimForRefund(booking.id, amount, reason, { onlyFrom: 'failed' });
  if (!won) {
    logger.info(`Retry for booking ${booking.id} lost the claim; someone else has it`);
    return { ...base, status: 'already_handled', refunded: false };
  }

  if (!booking.payment_id) {
    await markNeedsReview(booking, amount, 'The booking has no payment id to refund against.');
    return { ...base, status: 'needs_review', refunded: false };
  }

  // Rule 1: did the earlier attempt actually go through?
  let state;
  try {
    state = await PaymentService.fetchRefundState(booking.payment_id);
  } catch (err) {
    if (isPermanentGatewayError(err)) {
      const desc = err?.error?.description || err?.message;
      await markNeedsReview(booking, amount, `Could not read the payment from Razorpay: ${desc}`);
      return { ...base, status: 'needs_review', refunded: false, error: desc };
    }
    logger.warn(`Could not check payment for booking ${booking.id} before retrying: ${err?.message}`);
    await markFailed(booking);
    return { ...base, status: 'failed', refunded: false, error: err?.message };
  }

  const coverage = Policy.refundCoverage({ owed: amount, refundedPaise: state.refundedPaise });
  let outcome;

  if (coverage === 'full') {
    // It went through last time. Record it; do not call refund.
    logger.warn(`Booking ${booking.id}: earlier refund of ₹${amount} had succeeded; recording it`);
    await PaymentService.markPaymentRefunded(booking, amount);
    const settlement = await recordProcessed(booking, spot, { amount, reason, refundId: state.refundId });
    outcome = { status: 'processed', refunded: true, reconciled: true, settlement, refundId: state.refundId };
  } else if (coverage !== 'none') {
    const rupees = (state.refundedPaise / 100).toFixed(2);
    await markNeedsReview(
      booking, amount,
      `Razorpay shows ₹${rupees} already refunded against ₹${amount} owed.`
    );
    return { ...base, status: 'needs_review', refunded: false };
  } else {
    // Rule 2: the stored figure, not a fresh quote.
    outcome = await payClaimed(booking, spot, { amount, reason });
  }

  if (outcome.status === 'processed' && notifyDriver && booking.user_id) {
    try {
      await NotificationService.sendPushNotification(booking.user_id, {
        title: 'Your refund is on its way',
        body: `₹${amount} for booking #${booking.id} is being returned to your original payment method.`,
        data: { type: 'refund_processed', bookingId: parseInt(booking.id) },
      });
    } catch (err) {
      logger.warn(`Refund-success push failed for booking ${booking.id}: ${err?.message}`);
    }
  }

  return { ...base, ...outcome };
}

module.exports = {
  quote,
  refundBooking,
  retryRefund,
  claimForRefund,
  isPermanentGatewayError,
  TERMINAL_REFUND_STATUSES,
  RETRY_AFTER_MS,
};
