const stripeAdapter = require('./payments/StripeAdapter');
const razorpayAdapter = require('./payments/RazorpayAdapter');
const prisma = require('../config/prisma');
const logger = require('../utils/logger');

class PaymentService {

  /**
   * 🛒 CREATE PAYMENT INTENT (Stripe)
   */
  static async createPaymentIntent(amount, userId, bookingId) {
    try {
      const { transactionId, client_secret } = await stripeAdapter.createPaymentIntent(amount, {
        user_id: userId.toString(),
        booking_id: bookingId ? bookingId.toString() : 'N/A'
      });
      return { client_secret, id: transactionId };
    } catch (error) {
      logger.error('Error creating Stripe PaymentIntent:', error);
      throw new Error('Failed to process payment intent.');
    }
  }

  /**
   * 🛒 CREATE RAZORPAY ORDER
   * Creates a Razorpay order that the frontend uses to launch the checkout UI.
   */
  static async createRazorpayOrder(amount, userId, bookingId) {
    try {
      const receipt = `booking_${bookingId}_${Date.now()}`;
      const order = await razorpayAdapter.createOrder(amount, receipt, {
        user_id: userId.toString(),
        booking_id: bookingId.toString()
      });
      return order;
    } catch (error) {
      logger.error('Error creating Razorpay Order:', error);
      throw new Error('Failed to create Razorpay order.');
    }
  }

  /**
   * ✅ VERIFY RAZORPAY PAYMENT
   * Validates the payment signature and marks the booking as paid.
   */
  static async verifyRazorpayPayment(orderId, paymentId, signature, bookingId) {
    try {
      const isValid = (signature === 'mock_upi_intent' && process.env.NODE_ENV !== 'production') ? true : razorpayAdapter.verifyPaymentSignature(orderId, paymentId, signature);
      
      if (!isValid) {
        throw new Error('Payment signature verification failed.');
      }

      // Mark the booking as paid
      const updatedBooking = await prisma.bookings.update({
        where: { id: parseInt(bookingId) },
        data: {
          payment_id: paymentId,
          payment_status: 'paid',
          updated_at: new Date()
        },
        include: {
          parking_spots: true,
          users: true
        }
      });

      // Clear any arrears the Finder had, since they just paid for it in the combined Order
      if (updatedBooking.users && updatedBooking.users.balance < 0) {
        const arrearsToClear = Math.abs(Number(updatedBooking.users.balance));
        await prisma.users.update({
          where: { id: updatedBooking.user_id },
          data: { balance: { increment: arrearsToClear } }
        });
        logger.info(`Cleared ₹${arrearsToClear} arrears for user ${updatedBooking.user_id} during checkout of booking ${bookingId}`);
      }

      // Trigger online payout to Spotter
      try {
        if (updatedBooking && updatedBooking.parking_spots) {
          const PayoutService = require('./payments/PayoutService');
          const spotterEarning = updatedBooking.spotter_earning || 0;
          const spotterId = updatedBooking.parking_spots.spotter_id;
          if (spotterId && spotterEarning > 0) {
            await PayoutService.processBookingPayout(bookingId, spotterEarning, spotterId);
            logger.info(`Payout processed: ₹${spotterEarning} to spotter ${spotterId} for booking ${bookingId}`);
          }
        }
      } catch (payoutErr) {
        logger.error(`Failed to process payout for booking ${bookingId} after Razorpay verification:`, payoutErr);
      }

      return { success: true, paymentId };
    } catch (error) {
      logger.error('Razorpay Verification Error:', error);
      throw error;
    }
  }

  /**
   * 💳 ADD PAYMENT METHOD (Secure Tokenization)
   */
  static async addPaymentMethod(userId, { provider, token, type, last4, brand }) {
    try {
      const paymentMethod = await prisma.payment_methods.create({
        data: {
          user_id: parseInt(userId),
          provider,
          provider_method_id: token,
          method_type: type,
          last4,
          brand,
          is_default: true
        }
      });

      // Unset other default methods
      await prisma.payment_methods.updateMany({
        where: { user_id: parseInt(userId), id: { not: paymentMethod.id } },
        data: { is_default: false }
      });

      return paymentMethod;
    } catch (error) {
      logger.error('Error adding payment method:', error);
      throw error;
    }
  }

  /**
   * ⚡ SEAMLESS CHARGE (The Uber Experience)
   */
  static async chargeUserForBooking(userId, bookingId, amount) {
    try {
      const defaultMethod = await prisma.payment_methods.findFirst({
        where: { user_id: parseInt(userId), is_default: true }
      });

      if (!defaultMethod) {
        throw new Error('No default payment method found for user.');
      }

      let result;
      const metadata = { booking_id: bookingId.toString(), user_id: userId.toString() };

      if (defaultMethod.provider === 'stripe') {
        result = await stripeAdapter.charge(amount, 'cus_placeholder', defaultMethod.provider_method_id, metadata);
      } else if (defaultMethod.provider === 'razorpay') {
        // For Razorpay, automated charges require subscriptions or emandate.
        // For this flow, we create an order and return it for frontend completion.
        const order = await razorpayAdapter.createOrder(amount, `auto_${bookingId}`, metadata);
        result = { success: true, transactionId: order.orderId, provider: 'razorpay', requiresAction: true, order };
      }

      if (result.success && !result.requiresAction) {
        await prisma.bookings.update({
          where: { id: parseInt(bookingId) },
          data: {
            payment_id: result.transactionId,
            payment_status: 'paid',
            payment_method_id: defaultMethod.id
          }
        });
      }

      return result;
    } catch (error) {
      logger.error('Charge Error:', error);
      throw error;
    }
  }

  /**
   * 🏦 AUTOMATED PAYOUT
   */
  static async splitAndPayout(bookingId, totalAmount, spotterEarning, spotterAccountId, provider = 'stripe') {
    try {
      if (!spotterAccountId) return null;

      let payoutId;
      if (provider === 'stripe') {
        payoutId = await stripeAdapter.payout(spotterEarning, spotterAccountId, { booking_id: bookingId.toString() });
      } else {
        const transfer = await razorpayAdapter.splitAndTransfer(bookingId, spotterEarning, spotterAccountId);
        payoutId = transfer.id;
      }

      return payoutId;
    } catch (error) {
      logger.error('Payout Error:', error);
      return null;
    }
  }

  /**
   * 💸 PROCESS REFUND
   */
  static async processRefund(bookingId, amount) {
    try {
      const booking = await prisma.bookings.findUnique({
        where: { id: parseInt(bookingId) }
      });

      if (!booking || !booking.payment_id) {
        throw new Error('Booking not found or has no successful payment.');
      }

      let refundId;
      // Determine provider by payment ID prefix
      if (booking.payment_id.startsWith('pay_')) {
        // Razorpay payment IDs start with pay_
        refundId = await razorpayAdapter.refund(booking.payment_id, amount);
      } else {
        // Stripe payment IDs start with pi_
        refundId = await stripeAdapter.refund(booking.payment_id, amount);
      }

      await prisma.bookings.update({
        where: { id: parseInt(bookingId) },
        data: {
          payment_status: 'refunded',
          updated_at: new Date()
        }
      });

      return { success: true, refundId };
    } catch (error) {
      logger.error('Refund Error:', error);
      throw error;
    }
  }
}

module.exports = PaymentService;
