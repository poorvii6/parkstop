const prisma = require('../../config/prisma');
const CommissionService = require('../CommissionService');
const logger = require('../../utils/logger');

/**
 * BookingSettlementService
 * -------------------------
 * Pays the owner their share of a COMPLETED booking, once the driver's online
 * payment has actually been collected (payment_status === 'paid').
 *
 *   1. Compute the commission split (platform fee vs. owner earning).
 *   2. Store the split on the booking.
 *   3. Queue the owner credit (PayoutService.processBookingPayout).
 *
 * ParkStop is online-only, so there is no cash branch. Every step is safe to
 * repeat: processBookingPayout credits a booking at most once, however many
 * times it is called. If anything here fails, nothing is credited by hand —
 * the recovery sweep in bookingExpiryService finds paid bookings with no
 * payout and settles them, so earnings are never lost and never doubled.
 */
class BookingSettlementService {
  /**
   * @param {object} booking - a completed booking (id, total_price, payment_status)
   * @param {object} spot    - its parking spot (spotter_id, location_type)
   * @returns {Promise<{ spotterEarning:number, platformFee:number, settled:boolean }>}
   */
  static async settleCompletedBooking(booking, spot) {
    if (!spot || !spot.spotter_id) {
      return { spotterEarning: 0, platformFee: 0, settled: false };
    }

    // Never pay an owner before the driver's money is in.
    if (booking.payment_status !== 'paid') {
      return { spotterEarning: 0, platformFee: 0, settled: false };
    }

    const { spotterEarning, platformFee } = CommissionService.calculateCommission(
      booking.total_price,
      spot.location_type
    );

    try {
      await prisma.bookings.update({
        where: { id: parseInt(booking.id) },
        data: { platform_fee: platformFee, spotter_earning: spotterEarning },
      });

      const { payoutQueue } = require('../../jobs/queues');
      await payoutQueue.add('process-payout', {
        bookingId: booking.id,
        spotterEarning,
        spotterId: spot.spotter_id,
      });
      logger.info(`Owner credit queued: ₹${spotterEarning} to ${spot.spotter_id} for booking ${booking.id}`);

      return { spotterEarning, platformFee, settled: true };
    } catch (err) {
      logger.error(
        `Settlement for booking ${booking.id} failed; the recovery sweep will retry it:`,
        err
      );
      return { spotterEarning, platformFee, settled: false };
    }
  }
}

module.exports = BookingSettlementService;
