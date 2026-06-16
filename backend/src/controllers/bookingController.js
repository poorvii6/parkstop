const Booking = require('../models/Booking');
const ParkingSpot = require('../models/ParkingSpot');
const logger = require('../utils/logger');
const { emitToUser } = require('../config/socket');
const NotificationService = require('../services/notificationService');
const PaymentService = require('../services/paymentService');

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

      const { spot_id, start_time, end_time, slot_name, vehicle_type, vehicle_subtype } = req.body;

      const booking = await Booking.create({
        user_id: req.user.id,
        spot_id,
        start_time,
        end_time,
        slot_name: slot_name || null,
        vehicle_type: vehicle_type || 'car',
        vehicle_subtype: vehicle_subtype || null
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

      res.json({
        success: true,
        message: 'Booking completed successfully',
        data: completedBooking
      });

    } catch (error) {
      logger.error('Complete booking error:', error);

      res.status(400).json({
        success: false,
        message: error.message || 'Error completing booking'
      });
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


}

module.exports = BookingController;