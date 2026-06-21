const Booking = require('../models/Booking');
const ParkingSpot = require('../models/ParkingSpot');
const logger = require('../utils/logger');
const { emitToUser } = require('../config/socket');
const NotificationService = require('../services/notificationService');
const PaymentService = require('../services/paymentService');
const CommissionService = require('../services/CommissionService');
const PayoutService = require('../services/payments/PayoutService');

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

      // Real-time notification to Spotter
      try {
        const spot = await ParkingSpot.findById(spot_id);
        if (spot && spot.spotter_id) {
          booking.finder_name = req.user.name || 'A driver';
          await NotificationService.notifyNewBooking(spot.spotter_id, booking);
        }
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

      const completedBooking = await Booking.verifyCheckoutOTP(bookingId, otp);

      // 💰 Auto-payout or Cash Ledger logic
      try {
        const booking = await Booking.findById(bookingId);
        if (booking && (booking.payment_status === 'paid' || booking.payment_mode === 'cash')) {
          const spot = await ParkingSpot.findById(booking.spot_id);
          if (spot && spot.spotter_id) {
            const { spotterEarning, platformFee } = CommissionService.calculateCommission(
              booking.total_price, spot.location_type
            );

            // Update booking with commission split
            await require('../config/prisma').bookings.update({
              where: { id: parseInt(bookingId) },
              data: {
                platform_fee: platformFee,
                spotter_earning: spotterEarning,
                payment_status: booking.payment_mode === 'cash' ? 'paid' : booking.payment_status
              }
            });

            if (booking.payment_mode === 'cash') {
              // Deduct platform fee from spotter balance for cash payments
              await require('../config/prisma').users.update({
                where: { id: spot.spotter_id },
                data: { balance: { decrement: platformFee } }
              });
              logger.info(`Cash booking ${bookingId}: Deducted ₹${platformFee} from spotter ${spot.spotter_id} wallet`);
            } else {
              // Trigger online payout to Spotter
              await PayoutService.processBookingPayout(bookingId, spotterEarning, spot.spotter_id);
              logger.info(`Payout processed: ₹${spotterEarning} to spotter ${spot.spotter_id} for booking ${bookingId}`);
            }
          }
        }
      } catch (payoutErr) {
        logger.error(`Payout/Ledger error after checkout OTP for booking ${bookingId}:`, payoutErr);
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

      // 💰 Auto-payout or Cash Ledger logic
      try {
        const completedData = await Booking.findById(bookingId);
        if (completedData && (completedData.payment_status === 'paid' || completedData.payment_mode === 'cash')) {
          const { spotterEarning, platformFee } = CommissionService.calculateCommission(
            completedData.total_price, spot.location_type
          );

          // Update booking with commission split
          await require('../config/prisma').bookings.update({
            where: { id: parseInt(bookingId) },
            data: {
              platform_fee: platformFee,
              spotter_earning: spotterEarning,
              payment_status: completedData.payment_mode === 'cash' ? 'paid' : completedData.payment_status
            }
          });

          if (completedData.payment_mode === 'cash') {
            await require('../config/prisma').users.update({
              where: { id: spot.spotter_id },
              data: { balance: { decrement: platformFee } }
            });
            logger.info(`Cash booking ${bookingId}: Deducted ₹${platformFee} from spotter ${spot.spotter_id} wallet`);
          } else if (completedData.payment_status === 'paid') {
            await PayoutService.processBookingPayout(bookingId, spotterEarning, spot.spotter_id);
          }
        }
      } catch (payoutErr) {
        logger.error(`Payout/Ledger error after complete booking for ${bookingId}:`, payoutErr);
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

      // Mark as completed but unpaid
      const completedBooking = await require('../config/prisma').bookings.update({
        where: { id: parseInt(bookingId) },
        data: {
          status: 'completed',
          payment_status: 'unpaid_arrears',
          actual_end_time: new Date(),
          updated_at: new Date()
        }
      });

      // Calculate commission based on what WAS owed
      const { spotterEarning, platformFee } = CommissionService.calculateCommission(
        completedBooking.total_price, spot.location_type
      );

      // 1. Credit the Spotter their 80% so they don't suffer
      await require('../config/prisma').users.update({
        where: { id: spot.spotter_id },
        data: { balance: { increment: spotterEarning } }
      });

      // 2. Penalize the Finder by deducting the FULL amount from their balance
      await require('../config/prisma').users.update({
        where: { id: booking.user_id },
        data: { balance: { decrement: completedBooking.total_price } }
      });

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
      if (spot.spotter_id !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Unauthorized to manage this booking' });
      }

      const { spotterEarning, platformFee } = CommissionService.calculateCommission(
        booking.total_price, spot.location_type
      );

      // 1. Update Booking to paid with cash
      const updatedBooking = await require('../config/prisma').bookings.update({
        where: { id: parseInt(bookingId) },
        data: {
          payment_status: 'paid',
          payment_mode: 'cash',
          status: 'completed',
          platform_fee: platformFee,
          spotter_earning: spotterEarning,
          updated_at: new Date()
        }
      });

      // 2. Deduct platform fee from spotter's wallet
      if (platformFee > 0) {
        await require('../config/prisma').users.update({
          where: { id: spot.spotter_id },
          data: { balance: { decrement: platformFee } }
        });
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

      // Fetch Finder's arrears
      const finder = await require('../config/prisma').users.findUnique({
        where: { id: booking.user_id }
      });
      const arrears = finder && finder.balance < 0 ? Math.abs(Number(finder.balance)) : 0;

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
      const { additionalHours } = req.body;

      if (!additionalHours || additionalHours <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Valid additionalHours is required'
        });
      }

      const extendedBooking = await Booking.extend(bookingId, req.user.id, additionalHours);

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

      // Notify Spotter
      if (booking) {
        try {
          const spot = await ParkingSpot.findById(booking.spot_id);
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

        // Trigger automatic refund if booking was paid
        if (booking.payment_status === 'paid' && booking.payment_id) {
          try {
            logger.info(`Triggering automatic refund for cancelled booking: ${bookingId}`);
            await PaymentService.processRefund(bookingId, booking.total_price);
          } catch (refundErr) {
            logger.error(`Automatic refund failed for booking ${bookingId}:`, refundErr);
          }
        }
      }

      res.json({
        success: true,
        message: 'Booking cancelled successfully'
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