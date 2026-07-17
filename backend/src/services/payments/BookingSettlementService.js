const prisma = require('../../config/prisma');
const CommissionService = require('../CommissionService');
const logger = require('../../utils/logger');

/**
 * BookingSettlementService
 * -------------------------
 * Single source of truth for settling a COMPLETED booking's money:
 *   1. Compute the commission split (platform fee vs. spotter earning).
 *   2. Persist the split on the booking.
 *   3. Move the money:
 *        - cash   -> deduct the platform's cut from the spotter's wallet.
 *        - online -> queue a payout to the spotter, but ONLY once the finder's
 *                    payment has actually been collected (payment_status === 'paid').
 *   4. If anything fails, record a payout needing manual review, credit the
 *      spotter's wallet as a fallback, and notify them — so earnings are never
 *      silently lost.
 *
 * This centralizes logic that was previously copy-pasted (and subtly divergent)
 * across BookingController.verifyCheckoutOTP / completeBooking / finderCheckout.
 * The unified rule is the safest one: never pay a spotter before the money is in.
 */
class BookingSettlementService {
  /**
   * @param {object} booking - a completed booking (needs id, total_price,
   *                           payment_mode, payment_status).
   * @param {object} spot    - the parking spot (needs spotter_id, location_type).
   * @returns {Promise<{ spotterEarning:number, platformFee:number, settled:boolean }>}
   */
  static async settleCompletedBooking(booking, spot) {
    if (!spot || !spot.spotter_id) {
      return { spotterEarning: 0, platformFee: 0, settled: false };
    }

    const isCash = booking.payment_mode === 'cash';
    const isPaid = booking.payment_status === 'paid';

    // Do not settle until money is (cash) or will be (online, paid) collected.
    if (!isCash && !isPaid) {
      return { spotterEarning: 0, platformFee: 0, settled: false };
    }

    const { spotterEarning, platformFee } = CommissionService.calculateCommission(
      booking.total_price,
      spot.location_type
    );

    try {
      await prisma.bookings.update({
        where: { id: parseInt(booking.id) },
        data: {
          platform_fee: platformFee,
          spotter_earning: spotterEarning,
          payment_status: isCash ? 'paid' : booking.payment_status,
        },
      });

      if (isCash) {
        if (platformFee > 0) {
          await prisma.users.update({
            where: { id: spot.spotter_id },
            data: { balance: { decrement: platformFee } },
          });
        }
        logger.info(
          `Cash booking ${booking.id}: deducted ₹${platformFee} from spotter ${spot.spotter_id} wallet`
        );
      } else {
        // Online payment already collected -> queue the payout.
        const { payoutQueue } = require('../../jobs/queues');
        await payoutQueue.add('process-payout', {
          bookingId: booking.id,
          spotterEarning,
          spotterId: spot.spotter_id,
        });
        logger.info(
          `Payout queued: ₹${spotterEarning} to spotter ${spot.spotter_id} for booking ${booking.id}`
        );
      }

      return { spotterEarning, platformFee, settled: true };
    } catch (err) {
      await this.handleSettlementFailure(booking, spot, spotterEarning, err);
      return { spotterEarning, platformFee, settled: false };
    }
  }

  /**
   * Fallback when settlement fails: never lose the spotter's earnings.
   * Records a payout needing manual review, credits the wallet, and notifies.
   */
  static async handleSettlementFailure(booking, spot, spotterEarning, err) {
    logger.error(`Settlement failed for booking ${booking.id}:`, err);

    await prisma.payouts
      .create({
        data: {
          user_id: spot.spotter_id,
          booking_id: parseInt(booking.id),
          amount: spotterEarning || 0,
          status: 'failed_needs_retry',
          mode: 'UPI',
          failure_reason: err.message,
          narration: `FAILED payout - Booking #${booking.id} - needs manual review`,
        },
      })
      .catch((e) => logger.error('Could not create failed payout record:', e));

    if (spotterEarning) {
      await prisma.users
        .update({
          where: { id: spot.spotter_id },
          data: { balance: { increment: parseFloat(spotterEarning) } },
        })
        .catch((e) => logger.error('CRITICAL: balance credit also failed:', e));
    }

    try {
      const { emitToUser } = require('../../config/socket');
      emitToUser(spot.spotter_id, 'payout:pending', {
        bookingId: booking.id,
        amount: spotterEarning,
        message:
          'Your earnings are being processed and will reflect in your wallet shortly.',
      });
    } catch (e) {
      logger.error('Could not emit payout:pending event:', e);
    }
  }
}

module.exports = BookingSettlementService;
