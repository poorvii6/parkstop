const Booking = require('../models/Booking');
const ParkingSpot = require('../models/ParkingSpot');
const logger = require('../utils/logger');
const { emitToUser } = require('../config/socket');
const NotificationService = require('../services/notificationService');
const PaymentService = require('../services/paymentService');
const CommissionService = require('../services/CommissionService');
const PayoutService = require('../services/payments/PayoutService');
const BookingSettlementService = require('../services/payments/BookingSettlementService');
const BookingRefundService = require('../services/BookingRefundService');

class BookingController {

  /**
   * CREATE BOOKING (Finder Only)
   */
  static async createBooking(req, res) {
    try {
      if (!req.user.role || req.user.role.toLowerCase() !== 'finder') {
        return res.status(403).json({
          success: false,
          message: 'Only finders can create bookings'
        });
      }

      const { spot_id, start_time, end_time, slot_name, vehicle_type, vehicle_subtype, payment_mode } = req.body;

      const booking = await Booking.create({
        user_id: req.user.id,
        spot_id,
        start_time,
        end_time,
        slot_name: slot_name || null,
        vehicle_type: vehicle_type || 'car',
        vehicle_subtype: vehicle_subtype || null,
        payment_mode: payment_mode || 'online'
      });

      // Real-time notification to Spotter (and confirmation to the Finder)
      try {
        const spot = await ParkingSpot.findById(spot_id);
        if (spot && spot.spotter_id) {
          booking.finder_name = req.user.name || 'A driver';
          await NotificationService.notifyNewBooking(spot.spotter_id, booking);
        }
        // Confirm the reservation to the finder (their check-in OTP is in-app).
        await NotificationService.notifyBookingConfirmed(req.user.id, booking);
      } catch (err) {
        logger.error('Notification error in createBooking:', err);
      }

      res.status(201).json({
        success: true,
        message: 'Booking reserved. Share OTP with spotter.',
        data: booking
      });

    } catch (error) {
      logger.error('Create booking error details:', {
        message: error.message,
        stack: error.stack,
        user: req.user
      });

      res.status(400).json({
        success: false,
        message: error.message || 'Booking process encountered an unexpected error'
      });
    }
  }

  /**
   * 📍 NOTIFY SPOTTER: the driver is approaching the booked spot.
   * Called by the finder app once when it gets within range during navigation.
   */
  static async notifyNearby(req, res) {
    try {
      const bookingId = parseInt(req.params.id);
      const { distance_km } = req.body || {};
      const booking = await Booking.findById(bookingId);
      if (!booking) {
        return res.status(404).json({ success: false, message: 'Booking not found' });
      }
      // Only the finder who owns the booking may trigger this.
      if (booking.user_id !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Not your booking' });
      }
      const spot = await ParkingSpot.findById(booking.spot_id);
      if (spot && spot.spotter_id) {
        booking.finder_name = req.user.name || 'A driver';
        await NotificationService.notifyFinderNearby(spot.spotter_id, booking, Number(distance_km) || 0);
      }
      res.json({ success: true });
    } catch (error) {
      logger.error('notifyNearby error:', error);
      res.status(500).json({ success: false, message: 'Failed to send nearby alert' });
    }
  }

  /**
   * VERIFY OTP (Spotter Only)
   */
  static async verifyOTP(req, res) {
    try {
      if (!req.user.role || req.user.role.toLowerCase() !== 'spotter') {
        return res.status(403).json({
          success: false,
          message: 'Only spotters can verify OTP'
        });
      }

      const { bookingId, otp } = req.body;

      if (!bookingId || !otp) {
        return res.status(400).json({
          success: false,
          message: 'Booking ID and OTP are required'
        });
      }

      // Ensure spot belongs to this spotter
      const booking = await Booking.findById(bookingId);

      if (!booking) {
        return res.status(404).json({
          success: false,
          message: 'Booking not found'
        });
      }

      const spot = await ParkingSpot.findById(booking.spot_id);

      if (!spot || spot.spotter_id !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: 'Unauthorized to verify this booking'
        });
      }

      const updatedBooking = await Booking.verifyOTP(bookingId, otp);

      // Instantly tell the FINDER they're checked in so their screen advances
      // to the active session immediately (the 3s poll is a fallback, and was
      // also silently broken by a string-vs-number booking id mismatch).
      try { emitToUser(booking.user_id, 'booking:checkedin', updatedBooking); } catch (e) { logger.warn('checkedin emit failed:', e?.message); }

      res.json({
        success: true,
        message: 'Booking activated successfully',
        data: updatedBooking
      });

    } catch (error) {
      logger.error('OTP verification error:', error);

      res.status(400).json({
        success: false,
        message: error.message || 'OTP verification failed'
      });
    }
  }

  /**
   * VERIFY CHECKOUT OTP (Spotter Only)
   */
  static async verifyCheckoutOTP(req, res) {
    try {
      if (!req.user.role || req.user.role.toLowerCase() !== 'spotter') {
        return res.status(403).json({
          success: false,
          message: 'Only spotters can verify checkout OTP'
        });
      }

      const { bookingId, otp } = req.body;

      if (!bookingId || !otp) {
        return res.status(400).json({
          success: false,
          message: 'Booking ID and OTP are required'
        });
      }

      // Confirm this spotter actually owns the spot, exactly as verifyOTP does.
      // Without it any authenticated spotter could burn another booking's three
      // OTP attempts and lock its checkout permanently — the finder would then
      // be unable to end their session at all.
      const target = await Booking.findById(bookingId);
      if (!target) {
        return res.status(404).json({
          success: false,
          message: 'Booking not found'
        });
      }

      const targetSpot = await ParkingSpot.findById(target.spot_id);
      if (!targetSpot || targetSpot.spotter_id !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: 'Unauthorized to verify this booking'
        });
      }

      const completedBooking = await Booking.verifyCheckoutOTP(bookingId, otp);

      // 💰 Settle commission + payout (unified — see BookingSettlementService)
      const settledBooking = await Booking.findById(bookingId);
      if (settledBooking) {
        await BookingSettlementService.settleCompletedBooking(
          settledBooking,
          settledBooking.parking_spots
        );
      }

      res.json({
        success: true,
        message: 'Checkout verified and booking completed',
        data: completedBooking
      });

    } catch (error) {
      logger.error('Checkout verification error:', error);
      res.status(400).json({
        success: false,
        message: error.message || 'Checkout verification failed'
      });
    }
  }

  /**
   * FINDER CHECKOUT (Finder Only, bypasses checkout OTP)
   */
  static async finderCheckout(req, res) {
    try {
      if (!req.user.role || req.user.role.toLowerCase() !== 'finder') {
        return res.status(403).json({
          success: false,
          message: 'Only finders can end their session'
        });
      }

      const bookingId = req.params.id;
      const booking = await Booking.findById(bookingId);

      if (!booking) {
        return res.status(404).json({
          success: false,
          message: 'Booking not found'
        });
      }

      if (booking.user_id !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: 'Unauthorized to complete this booking'
        });
      }

      // Complete the booking directly
      const completedBooking = await Booking.complete(bookingId);

      // 💰 Settle commission + payout (unified — gated on payment collection)
      const settledBooking = await Booking.findById(bookingId);
      if (settledBooking) {
        await BookingSettlementService.settleCompletedBooking(
          settledBooking,
          settledBooking.parking_spots
        );
      }

      return res.status(200).json({
        success: true,
        message: 'Booking completed successfully',
        data: completedBooking
      });
    } catch (error) {
      logger.error('Error during finder checkout:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to end session'
      });
    }
  }

  /**
   * REQUEST CHECKOUT (Finder only)
   * Finder taps "End Session": lock the billable end time to NOW and move the
   * booking into the owner-confirmation gate. Payment stays locked until the spot
   * owner confirms (strict). Calling again while already pending just re-notifies
   * the owner (the "Nudge owner" button).
   */
  static async requestCheckout(req, res) {
    try {
      if (!req.user.role || req.user.role.toLowerCase() !== 'finder') {
        return res.status(403).json({ success: false, message: 'Only finders can end their session' });
      }

      const bookingId = req.params.id;
      const booking = await Booking.findById(bookingId);
      if (!booking) {
        return res.status(404).json({ success: false, message: 'Booking not found' });
      }
      if (booking.user_id !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Unauthorized' });
      }
      if (booking.status === 'completed' || booking.payment_status === 'paid') {
        return res.status(400).json({ success: false, message: 'This session is already closed' });
      }

      const spot = await ParkingSpot.findById(booking.spot_id);
      if (!spot) {
        return res.status(404).json({ success: false, message: 'Spot not found' });
      }

      const prisma = require('../config/prisma');
      let updated = booking;

      if (booking.status === 'active') {
        updated = await prisma.bookings.update({
          where: { id: parseInt(bookingId) },
          data: { status: 'checkout_pending', actual_end_time: new Date(), updated_at: new Date() }
        });
      } else if (booking.status !== 'checkout_pending') {
        return res.status(400).json({ success: false, message: 'Session cannot be checked out from its current state' });
      }
      // else already checkout_pending -> fall through and just re-notify (nudge)

      try {
        emitToUser(spot.spotter_id, 'booking:checkout_requested', {
          id: updated.id,
          spot_id: updated.spot_id,
          spot_title: spot.title,
          slot_name: updated.slot_name,
          total_price: updated.total_price,
          requested_at: new Date()
        });
      } catch (e) { logger.warn('checkout_requested emit failed:', e?.message); }

      return res.json({
        success: true,
        message: 'Waiting for the spot owner to confirm your checkout',
        data: updated
      });
    } catch (error) {
      logger.error('Request checkout error:', error);
      return res.status(500).json({ success: false, message: 'Failed to request checkout' });
    }
  }

  /**
   * CONFIRM CHECKOUT (Spotter only)
   * Owner confirms the finder has left. Finalises the session (same path as
   * finderCheckout) and unlocks the finder's payment screen via socket. Only
   * allowed from checkout_pending, so a finder can never self-checkout.
   */
  static async confirmCheckout(req, res) {
    try {
      if (!req.user.role || req.user.role.toLowerCase() !== 'spotter') {
        return res.status(403).json({ success: false, message: 'Only the spot owner can confirm checkout' });
      }

      const bookingId = req.params.id;
      const booking = await Booking.findById(bookingId);
      if (!booking) {
        return res.status(404).json({ success: false, message: 'Booking not found' });
      }

      const spot = await ParkingSpot.findById(booking.spot_id);
      if (!spot || spot.spotter_id !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Unauthorized to confirm this checkout' });
      }
      if (booking.status !== 'checkout_pending') {
        return res.status(400).json({ success: false, message: 'This booking is not awaiting your confirmation' });
      }

      const completedBooking = await Booking.complete(bookingId);

      const settledBooking = await Booking.findById(bookingId);
      if (settledBooking) {
        await BookingSettlementService.settleCompletedBooking(
          settledBooking,
          settledBooking.parking_spots
        );
      }

      try { emitToUser(booking.user_id, 'booking:checkout_confirmed', completedBooking); } catch (e) { logger.warn('checkout_confirmed emit failed:', e?.message); }

      return res.json({
        success: true,
        message: 'Checkout confirmed',
        data: completedBooking
      });
    } catch (error) {
      logger.error('Confirm checkout error:', error);
      return res.status(500).json({ success: false, message: error.message || 'Failed to confirm checkout' });
    }
  }

  /**
   * COMPLETE BOOKING (Spotter Only)
   */
  static async completeBooking(req, res) {
    try {
      if (!req.user.role || req.user.role.toLowerCase() !== 'spotter') {
        return res.status(403).json({
          success: false,
          message: 'Only spotters can complete bookings'
        });
      }

      const bookingId = req.params.id;
      const { otp } = req.body;

      const booking = await Booking.findById(bookingId);

      if (!booking) {
        return res.status(404).json({
          success: false,
          message: 'Booking not found'
        });
      }

      const spot = await ParkingSpot.findById(booking.spot_id);

      if (!spot || spot.spotter_id !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: 'Unauthorized to complete this booking'
        });
      }

      const completedBooking = await Booking.complete(bookingId, otp);

      // 💰 Settle commission + payout (unified — see BookingSettlementService)
      const settledData = await Booking.findById(bookingId);
      if (settledData) {
        await BookingSettlementService.settleCompletedBooking(
          settledData,
          settledData.parking_spots
        );
      }

      res.json({
        success: true,
        message: 'Booking completed successfully',
        data: completedBooking
      });

    } catch (error) {
      logger.error('Complete booking error:', error);
      res.status(400).json({
        success: false,
        message: error.message || 'Failed to complete booking'
      });
    }
  }

  /**
   * CHECKOUT UNPAID (Arrears System)
   * Called by Spotter if Finder drives away without paying.
   * Closes booking, gives Spotter their earnings, and puts Finder in negative balance.
   */
  static async checkoutUnpaid(req, res) {
    try {
      if (!req.user.role || req.user.role.toLowerCase() !== 'spotter') {
        return res.status(403).json({ success: false, message: 'Only spotters can perform this action' });
      }

      const bookingId = req.params.id;
      const booking = await Booking.findById(bookingId);

      if (!booking || booking.status === 'completed' || booking.payment_status === 'paid') {
        return res.status(400).json({ success: false, message: 'Booking already completed or paid' });
      }

      const spot = await ParkingSpot.findById(booking.spot_id);
      if (!spot || spot.spotter_id !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Unauthorized' });
      }

      const prisma = require('../config/prisma');

      // Mark as completed but unpaid in a database transaction
      const completedBooking = await prisma.$transaction(async (tx) => {
        const updatedBooking = await tx.bookings.update({
          where: { id: parseInt(bookingId) },
          data: {
            status: 'completed',
            payment_status: 'unpaid_arrears',
            actual_end_time: new Date(),
            updated_at: new Date()
          }
        });

        // Calculate commission based on what WAS owed
        const { spotterEarning } = CommissionService.calculateCommission(
          updatedBooking.total_price, spot.location_type
        );

        // 1. Credit the Spotter their 80% so they don't suffer
        await tx.users.update({
          where: { id: spot.spotter_id },
          data: { balance: { increment: spotterEarning } }
        });

        // 2. Penalize the Finder by deducting the FULL amount from their balance
        await tx.users.update({
          where: { id: booking.user_id },
          data: { balance: { decrement: updatedBooking.total_price } }
        });

        // 3. Give the slot back. The finder drove off without paying, but the
        //    bay is empty — the spotter must not lose capacity as well as money.
        const slotData = {
          available_slots: { increment: 1 },
          is_available: true,
          updated_at: new Date()
        };
        if (booking.vehicle_type === 'car') slotData.car_slots = { increment: 1 };
        else if (booking.vehicle_type === 'bike') slotData.bike_slots = { increment: 1 };

        await tx.parking_spots.update({
          where: { id: booking.spot_id },
          data: slotData
        });

        return updatedBooking;
      });

      // Recalculate spotterEarning and platformFee for logging
      const { spotterEarning } = CommissionService.calculateCommission(
        completedBooking.total_price, spot.location_type
      );

      logger.info(`Arrears applied for Booking ${bookingId}: Spotter ${spot.spotter_id} credited ₹${spotterEarning}. Finder ${booking.user_id} deducted ₹${completedBooking.total_price}.`);

      res.json({
        success: true,
        message: 'Finder marked as unpaid. Your wallet has been credited.',
        data: completedBooking
      });

    } catch (error) {
      logger.error('Checkout Unpaid error:', error);
      res.status(500).json({ success: false, message: 'Failed to process unpaid checkout' });
    }
  }

  /**
   * CHECKOUT CASH (Spotter only)
   * Completes the booking with cash payment and deducts platform fee from spotter
   */
  static async checkoutCash(req, res) {
    try {
      if (!req.user.role || req.user.role.toLowerCase() !== 'spotter') {
        return res.status(403).json({ success: false, message: 'Only spotters can perform this action' });
      }

      const bookingId = req.params.id;
      const booking = await Booking.findById(bookingId);

      if (!booking) {
        return res.status(404).json({ success: false, message: 'Booking not found' });
      }

      const spot = await ParkingSpot.findById(booking.spot_id);
      if (!spot || spot.spotter_id !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Unauthorized to manage this booking' });
      }

      // Without this, a double-tap on the Confirm Cash button runs the whole
      // block twice: the platform fee comes out of the spotter's wallet again,
      // and the slot is released twice. Every other checkout path already
      // refuses a second call; this one did not.
      if (booking.status === 'completed' || booking.payment_status === 'paid') {
        return res.status(400).json({ success: false, message: 'This booking is already closed' });
      }

      const { spotterEarning, platformFee } = CommissionService.calculateCommission(
        booking.total_price, spot.location_type
      );

      const prisma = require('../config/prisma');

      // Update booking and deduct platform fee from spotter in a transaction
      const updatedBooking = await prisma.$transaction(async (tx) => {
        // 1. Update Booking to paid with cash — guarded on status so two
        //    concurrent calls cannot both proceed.
        const claimed = await tx.bookings.updateMany({
          where: { id: parseInt(bookingId), status: { notIn: ['completed', 'cancelled', 'expired'] } },
          data: {
            payment_status: 'paid',
            payment_mode: 'cash',
            status: 'completed',
            platform_fee: platformFee,
            spotter_earning: spotterEarning,
            updated_at: new Date()
          }
        });

        if (claimed.count === 0) {
          throw new Error('This booking is already closed');
        }

        // 2. Deduct platform fee from spotter's wallet
        if (platformFee > 0) {
          await tx.users.update({
            where: { id: spot.spotter_id },
            data: { balance: { decrement: platformFee } }
          });
        }

        // 3. Give the slot back. The car has left; without this the spot's
        //    available_slots never recovers and the spotter quietly loses a
        //    slot of real capacity on every cash checkout.
        const slotData = {
          available_slots: { increment: 1 },
          is_available: true,
          updated_at: new Date()
        };
        if (booking.vehicle_type === 'car') slotData.car_slots = { increment: 1 };
        else if (booking.vehicle_type === 'bike') slotData.bike_slots = { increment: 1 };

        await tx.parking_spots.update({
          where: { id: booking.spot_id },
          data: slotData
        });

        return tx.bookings.findUnique({ where: { id: parseInt(bookingId) } });
      });

      if (platformFee > 0) {
        logger.info(`Cash checkout ${bookingId}: Deducted ₹${platformFee} from spotter ${spot.spotter_id}`);
      }
      res.json({
        success: true,
        message: 'Cash payment confirmed successfully',
        data: updatedBooking
      });

    } catch (error) {
      logger.error('Checkout Cash error:', error);
      res.status(500).json({ success: false, message: 'Failed to process cash checkout' });
    }
  }

  /**
   * GET CHECKOUT AMOUNT (Spotter or Finder)
   * Calculates the final amount including arrears for the QR Code display
   */
  static async getCheckoutAmount(req, res) {
    try {
      const bookingId = req.params.id;
      const booking = await Booking.findById(bookingId);

      if (!booking) {
        return res.status(404).json({ success: false, message: 'Booking not found' });
      }

      // Lock-in the quoted price from booking time
      const basePrice = Number(booking.total_price || 0);

      // Fetch Finder's arrears safely
      let arrears = 0;
      if (booking.user_id) {
        const finder = await require('../config/prisma').users.findUnique({
          where: { id: booking.user_id }
        });
        arrears = finder && finder.balance < 0 ? Math.abs(Number(finder.balance)) : 0;
      }

      res.json({
        success: true,
        data: {
          booking_id: booking.id,
          base_price: basePrice,
          arrears: arrears,
          total_amount: basePrice + arrears
        }
      });

    } catch (error) {
      logger.error('Get checkout amount error:', error);
      res.status(500).json({ success: false, message: 'Failed to calculate amount' });
    }
  }

  /**
   * EXTEND BOOKING (Finder Only)
   */
  static async extendBooking(req, res) {
    try {
      if (!req.user.role || req.user.role.toLowerCase() !== 'finder') {
        return res.status(403).json({
          success: false,
          message: 'Only finders can extend bookings'
        });
      }

      const bookingId = req.params.id;
      const { additionalHours, additionalMinutes } = req.body;

      // Accept either minutes (preferred, for 5/10/20/30-min top-ups) or whole
      // hours, and normalise to fractional hours so every extension shares one
      // path. Pricing and end_time math already handle fractional hours.
      let totalMinutes = Number(additionalMinutes);
      if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) {
        totalMinutes = Number(additionalHours) * 60;
      }
      totalMinutes = Math.round(totalMinutes);

      if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) {
        return res.status(400).json({
          success: false,
          message: 'A valid extension duration is required'
        });
      }
      if (totalMinutes > 1440) {
        return res.status(400).json({
          success: false,
          message: 'You can extend by at most 24 hours at a time'
        });
      }

      const extendedBooking = await Booking.extend(bookingId, req.user.id, totalMinutes / 60);

      res.json({
        success: true,
        message: 'Booking extended successfully',
        data: extendedBooking
      });

    } catch (error) {
      logger.error('Extend booking error:', error);

      res.status(400).json({
        success: false,
        message: error.message || 'Error extending booking'
      });
    }
  }

  /**
 * CANCEL BOOKING (Finder Only)
 */
  static async cancelBooking(req, res) {
    try {

      if (!req.user.role || req.user.role.toLowerCase() !== 'finder') {
        return res.status(403).json({
          success: false,
          message: 'Only finders can cancel bookings'
        });
      }

      const bookingId = req.params.id;
      const booking = await Booking.findById(bookingId);

      await Booking.cancel(bookingId, req.user.id);

      let refund = null;

      // Notify Spotter
      if (booking) {
        const spot = await ParkingSpot.findById(booking.spot_id);

        try {
          if (spot) {
            emitToUser(spot.spotter_id, 'booking:cancelled', { bookingId });

            // Push Notification
            await NotificationService.sendPushNotification(spot.spotter_id, {
              title: 'Booking Cancelled ❌',
              body: `Booking #${bookingId} has been cancelled by the driver.`,
              data: { bookingId: parseInt(bookingId), type: 'booking_cancelled' }
            });
          }
        } catch (err) {
          logger.error('Notification error in cancelBooking:', err);
        }

        // Refund according to the ladder, not in full. Cancelling still costs
        // the owner a bay they held and could not sell, so they keep a share —
        // 30% if there was more than half an hour's notice, 50% if not. The
        // advance fee is never returned.
        if (Number(booking.amount_paid) > 0) {
          try {
            refund = await BookingRefundService.refundBooking(booking, spot, {
              reason: 'finder_cancelled'
            });
          } catch (refundErr) {
            // The booking IS cancelled and the bay IS released — that already
            // committed. Failing the response here would tell the finder the
            // cancellation didn't work and invite them to try again.
            logger.error(`Refund failed for cancelled booking ${bookingId}:`, refundErr);
          }
        }
      }

      res.json({
        success: true,
        message: refund && refund.refundAmount > 0
          ? `Booking cancelled. ₹${refund.refundAmount} will be returned to your original payment method.`
          : 'Booking cancelled successfully',
        data: refund
          ? {
              refund_amount: refund.refundAmount,
              refund_status: refund.status,
              withheld_amount: refund.withheldAmount,
              tier: refund.tier
            }
          : undefined
      });

    } catch (error) {
      logger.error('Cancel booking error:', error);

      res.status(400).json({
        success: false,
        message: error.message
      });
    }
  }

  /**
   * GET FINDER BOOKINGS
   */
  static async getUserBookings(req, res) {
    try {
      if (!req.user.role || req.user.role.toLowerCase() !== 'finder') {
        return res.status(403).json({
          success: false,
          message: 'Only finders can view their bookings'
        });
      }

      const bookings = await Booking.findByUser(req.user.id);

      res.json({
        success: true,
        data: bookings
      });

    } catch (error) {
      logger.error('Get user bookings error:', error);

      res.status(500).json({
        success: false,
        message: 'Error fetching bookings'
      });
    }
  }

  /**
   * GET SPOTTER BOOKINGS
   */
  static async getSpotterBookings(req, res) {
    try {
      if (!req.user.role || req.user.role.toLowerCase() !== 'spotter') {
        return res.status(403).json({
          success: false,
          message: 'Only spotters can access this'
        });
      }

      const bookings = await Booking.findBySpotter(req.user.id);

      res.json({
        success: true,
        data: bookings
      });

    } catch (error) {
      logger.error('Get spotter bookings error:', error);

      res.status(500).json({
        success: false,
        message: 'Error fetching bookings'
      });
    }
  }

  /**
   * CALCULATE UPFRONT DYNAMIC PRICE
   */
  static async calculateUpfrontPrice(req, res) {
    try {
      const { spot_id, start_time, end_time } = req.body;

      if (!spot_id || !start_time || !end_time) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
      }

      const spot = await ParkingSpot.findById(spot_id);
      if (!spot) {
        return res.status(404).json({ success: false, message: 'Spot not found' });
      }

      const start = new Date(start_time);
      const end = new Date(end_time);
      if (end <= start) {
        return res.status(400).json({ success: false, message: 'Invalid duration' });
      }

      const diffMs = end - start;
      const hours = Math.max(1, Math.ceil(diffMs / (1000 * 60)) / 60);

      const PricingService = require('../services/PricingService');
      const pricing = await PricingService.calculatePrice({
        basePrice: Number(spot.price_per_hour),
        locationType: spot.location_type || 'urban',
        spotId: spot.id
      });

      const total_price = Number((hours * pricing.finalPrice).toFixed(2));

      res.json({
        success: true,
        data: {
          hours,
          pricing,
          total_price
        }
      });

    } catch (error) {
      logger.error('Error calculating upfront price:', error);
      res.status(500).json({ success: false, message: 'Error calculating price' });
    }
  }

  /**
   * CLAIM NO-SHOW REFUND (Finder Only)
   *
   * A finder who never arrived is owed half their spot fee, but deliberately
   * has to ask — the sweep only marks it claimable. This is where it is
   * actually paid, and it is the only caller that passes force, because every
   * other path must respect the "requires a claim" flag.
   */
  static async claimRefund(req, res) {
    try {
      if (!req.user.role || req.user.role.toLowerCase() !== 'finder') {
        return res.status(403).json({
          success: false,
          message: 'Only finders can claim a refund'
        });
      }

      const bookingId = req.params.id;
      const booking = await Booking.findById(bookingId);

      if (!booking) {
        return res.status(404).json({ success: false, message: 'Booking not found' });
      }

      if (booking.user_id !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Not your booking' });
      }

      if (booking.refund_status === 'processed') {
        // Not an error — someone tapping twice should see the outcome, not a
        // failure that makes them think it did not work.
        return res.json({
          success: true,
          message: 'This refund has already been paid.',
          data: { refund_amount: Number(booking.refund_amount) || 0, refund_status: 'processed' }
        });
      }

      if (booking.refund_status !== 'claimable') {
        return res.status(400).json({
          success: false,
          message: 'There is no refund to claim on this booking'
        });
      }

      const spot = await ParkingSpot.findById(booking.spot_id);
      const refund = await BookingRefundService.refundBooking(booking, spot, {
        reason: 'no_show',
        force: true
      });

      if (refund.status === 'failed') {
        return res.status(502).json({
          success: false,
          message: 'We could not reach the payment provider. Please try again shortly.'
        });
      }

      return res.json({
        success: true,
        message: `₹${refund.refundAmount} is on its way back to your original payment method.`,
        data: {
          refund_amount: refund.refundAmount,
          refund_status: refund.status,
          withheld_amount: refund.withheldAmount
        }
      });

    } catch (error) {
      logger.error('Claim refund error:', error);
      return res.status(500).json({ success: false, message: 'Failed to claim refund' });
    }
  }

  /**
   * UPDATE PAYMENT MODE (Finder Only)
   */
  static async updatePaymentMode(req, res) {
    try {
      if (!req.user.role || req.user.role.toLowerCase() !== 'finder') {
        return res.status(403).json({
          success: false,
          message: 'Only finders can update payment mode'
        });
      }

      const bookingId = req.params.id;
      const { payment_mode } = req.body;

      if (!payment_mode || !['online', 'cash'].includes(payment_mode)) {
        return res.status(400).json({
          success: false,
          message: 'Valid payment_mode is required (online or cash)'
        });
      }

      const updatedBooking = await Booking.updatePaymentMode(bookingId, req.user.id, payment_mode);

      res.json({
        success: true,
        message: 'Payment mode updated successfully',
        data: updatedBooking
      });

    } catch (error) {
      logger.error('Update payment mode error:', error);
      res.status(400).json({
        success: false,
        message: error.message || 'Error updating payment mode'
      });
    }
  }

}

module.exports = BookingController;