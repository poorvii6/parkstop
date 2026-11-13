const cron = require('node-cron');
const prisma = require('../config/prisma');
const logger = require('../utils/logger');
const NotificationService = require('../services/notificationService');
const BookingRefundService = require('../services/BookingRefundService');

/**
 * Expire ONE reserved booking and hand its slot back.
 *
 * The sweep reads a batch of candidates and then writes them one at a time, so
 * there is always a gap between "this looked expired" and "this is being
 * expired". A rider can hand their OTP to the owner inside that gap, which
 * flips the booking to active. The previous code updated unconditionally, so it
 * would mark that live booking expired and return its slot to the pool — the
 * car is sitting in the bay while the app advertises it as free, and the rider's
 * session is dead.
 *
 * Claiming the row with updateMany + a status guard makes the transition
 * atomic: if anything else moved the booking first, count is 0 and we leave the
 * spot alone.
 *
 * @returns {Promise<boolean>} true if this call is the one that expired it.
 */
const expireReservation = async (booking, now) => {
  const claimed = await prisma.bookings.updateMany({
    where: { id: booking.id, status: 'reserved' },
    data: { status: 'expired', updated_at: now }
  });

  if (claimed.count === 0) return false;

  const updateData = {
    available_slots: { increment: 1 },
    is_available: true
  };
  if (booking.vehicle_type === 'car') updateData.car_slots = { increment: 1 };
  else if (booking.vehicle_type === 'bike') updateData.bike_slots = { increment: 1 };

  await prisma.parking_spots.update({
    where: { id: booking.spot_id },
    data: updateData
  });

  return true;
};

// How long a driver may stay past their booked end before the session is
// closed for them, and how long an owner has to confirm a checkout before
// ParkStop confirms it on their behalf.
const OVERSTAY_GRACE_MS = 2 * 60 * 60 * 1000;
const OWNER_CONFIRM_TIMEOUT_MS = 15 * 60 * 1000;
// Only bookings paid after this go through the recovery sweep. Older ones were
// settled by code that sometimes credited the wallet without a payout row, and
// must not be credited a second time.
const RECOVERY_SWEEP_FROM = new Date('2026-10-12T00:00:00+05:30');

/**
 * Close ONE session through the normal checkout path (Booking.complete), so
 * the bill, the slot and the commission are worked out exactly as when the
 * owner confirms. Booking.complete locks the row, so if the owner or driver
 * closed it in the meantime this throws 'Booking not active' and does nothing.
 *
 * @returns {Promise<object|null>} the completed booking, or null if it was already closed
 */
const closeSession = async (bookingId) => {
  const Booking = require('../models/Booking');
  try {
    return await Booking.complete(bookingId);
  } catch (err) {
    if (/not active/i.test(err.message)) return null;
    throw err;
  }
};

/** Tell the driver to pay, and switch their app to the payment screen. */
const askDriverToPay = async (completed, title, body) => {
  try {
    const { emitToUser } = require('../config/socket');
    emitToUser(completed.user_id, 'booking:checkout_confirmed', completed);
  } catch (e) {
    logger.warn(`checkout_confirmed emit failed for booking ${completed.id}: ${e?.message}`);
  }
  try {
    await NotificationService.sendPushNotification(completed.user_id, {
      title,
      body,
      data: { bookingId: completed.id, type: 'payment_due' },
    });
  } catch (e) {
    logger.warn(`Payment reminder failed for booking ${completed.id}: ${e?.message}`);
  }
};

/**
 * Paid bookings whose owner was never credited (a crash, a queue outage).
 * processBookingPayout is idempotent, so retrying is always safe.
 *
 * Any payment mode. This used to require payment_mode = 'online', which was
 * written when cash existed as a separate path; a cash booking whose owner
 * credit failed was then never retried and the owner simply lost it. What
 * matters is that the money came in (payment_status = 'paid'), not how.
 */
const recoverUnsettledPayouts = async (now) => {
  const rows = await prisma.$queryRaw`
    SELECT b.id, b.spotter_earning, s.spotter_id
    FROM bookings b
    JOIN parking_spots s ON s.id = b.spot_id
    LEFT JOIN payouts p ON p.booking_id = b.id
    WHERE p.id IS NULL
      AND b.status = 'completed'
      AND b.payment_status = 'paid'
      AND b.spotter_earning > 0
      AND b.updated_at >= ${RECOVERY_SWEEP_FROM}
      AND b.updated_at < ${new Date(now.getTime() - 5 * 60 * 1000)}
    LIMIT 50
  `;
  const PayoutService = require('./payments/PayoutService');
  for (const r of rows) {
    try {
      await PayoutService.processBookingPayout(r.id, Number(r.spotter_earning), r.spotter_id);
      logger.warn(`Recovered missing owner credit for booking ${r.id}`);
    } catch (err) {
      logger.error(`Recovery credit failed for booking ${r.id}:`, err);
    }
  }
  return rows.length;
};

/**
 * Refunds whose gateway call failed with a network or 5xx error.
 *
 * A handful per run, oldest first, and only once they have sat for 15 minutes
 * so a flapping gateway is not hammered every minute. retryRefund claims each
 * row with the same guard the first attempt uses (and requires it to still be
 * 'failed'), so two overlapping runs cannot both pay it. It also asks Razorpay
 * whether the earlier attempt went through before calling refund again.
 */
const REFUND_RETRY_BATCH = 5;

/** No-shows whose owner credit is backfilled per run. */
const CLAIMABLE_SETTLE_BATCH = 5;

/**
 * No-shows sitting at 'claimable' whose owner was never credited.
 *
 * Owner credit for a no-show now happens at expiry. Before that it only
 * happened if the driver came back and claimed their refund, so every booking
 * already parked at 'claimable' has withheld money that was never split — and
 * the drivers who matter here are precisely the ones who never returned, so
 * nothing will ever trigger it. This pays the owner's side, oldest first, a few
 * per run.
 *
 * It cannot credit twice, by three independent guards:
 *   1. the LEFT JOIN drops any booking that already has a payouts row;
 *   2. settleWithheld checks again for that row inside the transaction, so two
 *      overlapping runs cannot both write;
 *   3. payouts.booking_id is UNIQUE in the database, which rolls back the whole
 *      transaction — credit included — if the first two are ever bypassed.
 *
 * refund_amount < amount_paid excludes bookings that withhold nothing: those
 * settle to a zero owner share, write no payouts row, and would otherwise be
 * re-selected by this query on every single run forever.
 */
const settleClaimableNoShows = async () => {
  const rows = await prisma.$queryRaw`
    SELECT b.id
    FROM bookings b
    JOIN parking_spots s ON s.id = b.spot_id
    LEFT JOIN payouts p ON p.booking_id = b.id
    WHERE p.id IS NULL
      AND b.refund_status = 'claimable'
      AND b.payment_status = 'paid'
      AND b.amount_paid > 0
      AND b.refund_amount IS NOT NULL
      AND b.refund_amount < b.amount_paid
      AND s.spotter_id IS NOT NULL
    ORDER BY b.updated_at ASC
    LIMIT ${CLAIMABLE_SETTLE_BATCH}
  `;

  for (const r of rows) {
    try {
      const booking = await prisma.bookings.findUnique({ where: { id: Number(r.id) } });
      if (!booking) continue;
      const spot = await prisma.parking_spots.findUnique({ where: { id: booking.spot_id } });
      const settlement = await BookingRefundService.settleNoShowWithheld(booking, spot, {
        reason: booking.cancellation_reason || 'no_show',
        // The figure already stored on the booking, never a fresh quote: the
        // driver was told this amount and may still claim exactly it.
        refundAmount: Number(booking.refund_amount),
      });
      if (settlement?.credited) {
        logger.warn(
          `Backfilled owner credit ₹${settlement.ownerAmount} for no-show booking ${booking.id}`
        );
      }
    } catch (err) {
      logger.error(`Owner credit for claimable no-show ${r.id} failed:`, err);
    }
  }
  return rows.length;
};

const retryFailedRefunds = async (now) => {
  const rows = await prisma.bookings.findMany({
    where: {
      refund_status: 'failed',
      updated_at: { lt: new Date(now.getTime() - BookingRefundService.RETRY_AFTER_MS) },
    },
    orderBy: { updated_at: 'asc' },
    take: REFUND_RETRY_BATCH,
  });

  for (const booking of rows) {
    try {
      const spot = booking.spot_id
        ? await prisma.parking_spots.findUnique({ where: { id: booking.spot_id } })
        : null;
      const r = await BookingRefundService.retryRefund(booking, spot);
      logger.info(`Refund retry for booking ${booking.id}: ${r.status}`);
    } catch (err) {
      logger.error(`Refund retry failed for booking ${booking.id}:`, err);
    }
  }
  return rows.length;
};

const startBookingExpiryJob = () => {
  // Run every minute
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();

      /**
       * 1️⃣ EXPIRE RESERVED BOOKINGS
       * Bookings that weren't verified via OTP within 30 mins
       */
      const expiredReserved = await prisma.bookings.findMany({
        where: {
          status: 'reserved',
          otp_expires_at: { lte: now }
        }
      });

      if (expiredReserved.length > 0) {
        logger.info(`Cleaning up ${expiredReserved.length} expired reservations...`);
        
        for (let booking of expiredReserved) {
          try {
            const didExpire = await expireReservation(booking, now);
            // Only act if THIS call is the one that expired it — otherwise a
            // retry would notify a rider about a booking they already checked
            // into, or mark a refund on one that completed normally.
            if (didExpire) {
              let refundNote = null;

              // A prepaid finder who never arrived is owed half their spot fee,
              // but deliberately has to ask for it. Mark it claimable and stop;
              // only the claim endpoint actually moves the money.
              if (Number(booking.amount_paid) > 0) {
                try {
                  const spot = await prisma.parking_spots.findUnique({
                    where: { id: booking.spot_id }
                  });
                  refundNote = await BookingRefundService.refundBooking(booking, spot, {
                    reason: 'no_show',
                    now
                  });
                } catch (refundErr) {
                  logger.error(`Could not mark no-show refund for booking ${booking.id}:`, refundErr);
                }
              }

              try {
                await NotificationService.notifyBookingExpired(
                  booking.user_id,
                  booking,
                  refundNote && refundNote.refundAmount > 0 ? refundNote.refundAmount : 0
                );
              } catch (notifyErr) {
                logger.warn(`Expiry notice failed for booking ${booking.id}: ${notifyErr?.message}`);
              }
            }
          } catch (err) {
            // One bad row must not abort the rest of the sweep, or a single
            // deleted spot strands every later booking in the batch.
            logger.error(`Failed to expire reservation ${booking.id}:`, err);
          }
        }
      }

      /**
       * 1️⃣b WARN BEFORE THE HOLD LAPSES
       * One nudge at the 5-minutes-left mark. warned_at (or the absence of it)
       * is what stops this firing every minute for the same booking; the sweep
       * runs on a 1-minute tick so the window is exactly one pass wide.
       */
      const warnFrom = new Date(now.getTime() + 4 * 60 * 1000);
      const warnTo = new Date(now.getTime() + 5 * 60 * 1000);
      const expiringSoon = await prisma.bookings.findMany({
        where: {
          status: 'reserved',
          otp_expires_at: { gt: warnFrom, lte: warnTo }
        }
      });

      for (const booking of expiringSoon) {
        try {
          await NotificationService.notifyBookingExpiringSoon(booking.user_id, booking, 5);
        } catch (err) {
          logger.warn(`Expiry warning failed for booking ${booking.id}: ${err?.message}`);
        }
      }

      /**
       * 2️⃣ BOOKED TIME IS UP
       * One reminder when the booked window ends. The session is NOT closed
       * then: the car is usually still there, and freeing the bay would let
       * someone else book a space that is physically taken. Extra time is
       * billed when the driver ends the session.
       */
      const endedNow = await prisma.bookings.findMany({
        where: {
          status: 'active',
          end_time: { gt: new Date(now.getTime() - 60 * 1000), lte: now }
        },
        select: { id: true, user_id: true }
      });
      for (const b of endedNow) {
        try {
          await NotificationService.sendPushNotification(b.user_id, {
            title: 'Your booked time is up',
            body: 'Extend your stay or end the session in ParkStop. Extra time is charged by the hour.',
            data: { bookingId: b.id, type: 'time_up' }
          });
        } catch (err) {
          logger.warn(`Time-up reminder failed for booking ${b.id}: ${err?.message}`);
        }
      }

      /**
       * 3️⃣ FORGOTTEN SESSIONS
       * Still active long after the booked end: close it so the bay is freed,
       * bill up to now, and ask the driver to pay.
       */
      const forgotten = await prisma.bookings.findMany({
        where: {
          status: 'active',
          end_time: { lte: new Date(now.getTime() - OVERSTAY_GRACE_MS) }
        },
        select: { id: true }
      });
      for (const b of forgotten) {
        try {
          const completed = await closeSession(b.id);
          if (completed) {
            logger.info(`Closed forgotten session ${b.id}`);
            await askDriverToPay(completed, 'Your parking was ended',
              'Your session ran well past its booked time, so we ended it. Please pay in ParkStop.');
          }
        } catch (err) {
          logger.error(`Failed to close forgotten session ${b.id}:`, err);
        }
      }

      /**
       * 4️⃣ OWNER DID NOT CONFIRM CHECKOUT
       * The driver tapped "End session" and the owner has not responded. The
       * bill was already fixed at that moment (actual_end_time), so confirming
       * for them cannot overcharge anyone — it just lets the driver pay.
       */
      const unconfirmed = await prisma.bookings.findMany({
        where: {
          status: 'checkout_pending',
          actual_end_time: { lte: new Date(now.getTime() - OWNER_CONFIRM_TIMEOUT_MS) }
        },
        select: { id: true }
      });
      for (const b of unconfirmed) {
        try {
          const completed = await closeSession(b.id);
          if (completed) {
            logger.info(`Auto-confirmed checkout for booking ${b.id} (owner did not respond)`);
            await askDriverToPay(completed, 'Checkout confirmed',
              'The spot owner did not respond, so we confirmed your checkout. Please pay in ParkStop.');
          }
        } catch (err) {
          logger.error(`Failed to auto-confirm checkout ${b.id}:`, err);
        }
      }

      /**
       * 5️⃣ RECOVERY: paid bookings whose owner was never credited.
       */
      try {
        await recoverUnsettledPayouts(now);
      } catch (err) {
        logger.error('Owner-credit recovery sweep failed:', err);
      }

      /**
       * 6️⃣ RETRY REFUNDS that failed on a temporary gateway error.
       */
      try {
        await retryFailedRefunds(now);
      } catch (err) {
        logger.error('Refund retry sweep failed:', err);
      }

      /**
       * 7️⃣ BACKFILL: no-shows left claimable before owner credit moved to
       * expiry. New ones are settled as they expire, so this drains and stays
       * empty.
       */
      try {
        await settleClaimableNoShows();
      } catch (err) {
        logger.error('Claimable no-show settle sweep failed:', err);
      }

    } catch (error) {
      logger.error('Booking lifecycle job error:', error);
    }
  });

  logger.info('✅ Booking expiry job service initialized');
};

module.exports = startBookingExpiryJob;
// Named exports so the claim-first behaviour can be tested without a scheduler.
module.exports.expireReservation = expireReservation;
module.exports.closeSession = closeSession;
module.exports.recoverUnsettledPayouts = recoverUnsettledPayouts;
module.exports.retryFailedRefunds = retryFailedRefunds;
module.exports.settleClaimableNoShows = settleClaimableNoShows;