const cron = require('node-cron');
const prisma = require('../config/prisma');
const logger = require('../utils/logger');
const PricingService = require('../services/PricingService');
const CommissionService = require('../services/CommissionService');
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

/**
 * Auto-complete ONE active booking whose end_time has passed. Same claim-first
 * reasoning: if the finder checked out in the meantime, this must be a no-op
 * rather than a second slot release.
 *
 * @returns {Promise<boolean>} true if this call is the one that completed it.
 */
const autoCompleteBooking = async (booking, data, now) => {
  const claimed = await prisma.bookings.updateMany({
    where: { id: booking.id, status: 'active' },
    data: { ...data, updated_at: now }
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
       * 2️⃣ AUTO-COMPLETE ACTIVE BOOKINGS
       * Bookings that reached their end_time
       */
      const activeExpired = await prisma.bookings.findMany({
        where: {
          status: 'active',
          end_time: { lte: now }
        },
        include: {
          parking_spots: true
        }
      });

      if (activeExpired.length > 0) {
        logger.info(`Auto-completing ${activeExpired.length} finished bookings...`);

        for (let booking of activeExpired) {
          const startTime = new Date(booking.start_time);
          const minutes = Math.ceil((now - startTime) / (1000 * 60));
          // Match Booking.complete(): a minimum of one HOUR, not one minute.
          // The old `Math.max(1, minutes) / 60` floored at 0.0167h, so an
          // identical session was billed a fraction of a rupee when the sweep
          // closed it and a full hour when the owner did.
          const hours = Math.max(1, minutes / 60);

          const pricing = await PricingService.calculatePrice({
            basePrice: Number(booking.parking_spots.price_per_hour),
            locationType: booking.parking_spots.location_type || 'urban',
            spotId: booking.spot_id
          });

          const finalPrice = Number((hours * pricing.finalPrice).toFixed(2));
          const commission = CommissionService.calculateCommission(
            finalPrice,
            booking.parking_spots.location_type || 'urban'
          );

          try {
            await autoCompleteBooking(booking, {
              status: 'completed',
              actual_end_time: now,
              total_price: finalPrice,
              hours: hours,
              platform_fee: commission.platformFee,
              spotter_earning: commission.spotterEarning
            }, now);
          } catch (err) {
            logger.error(`Failed to auto-complete booking ${booking.id}:`, err);
          }
        }
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
module.exports.autoCompleteBooking = autoCompleteBooking;