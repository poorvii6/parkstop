const PaymentService = require('../services/paymentService');
const logger = require('../utils/logger');
const Booking = require('../models/Booking');

class PaymentController {

  /**
   * 🛒 INITIATE CHECKOUT
   * Called by the frontend right before paying for a reservation.
   */
  static async createCheckoutSession(req, res) {
    try {
      if (req.user.role !== 'finder') {
        return res.status(403).json({ success: false, message: 'Only finders can process payments' });
      }

      const { bookingId } = req.body;
      if (!bookingId) {
        return res.status(400).json({ success: false, message: 'Booking ID is required' });
      }

      // Fetch the booking to ensure it belongs to this user and is unpaid/reserved
      const booking = await Booking.findById(bookingId);

      if (!booking) {
        return res.status(404).json({ success: false, message: 'Booking not found' });
      }
      if (booking.user_id !== req.user.id) {
         return res.status(403).json({ success: false, message: 'Unauthorized access to this booking' });
      }

      // Find the spot and the spotter
      const spot = await require('../config/prisma').parking_spots.findUnique({
        where: { id: booking.spot_id },
        include: { users: true }
      });
      const spotter = spot?.users;

      // Enforce Razorpay exclusively as the active gateway for the Indian market
      const useRazorpay = true;

      if (useRazorpay) {
        const order = await PaymentService.createRazorpayOrder(booking.total_price, req.user.id, bookingId);
        res.json({
          success: true,
          provider: 'razorpay',
          order_id: order.orderId,
          amount: order.amount,
          currency: order.currency,
          key_id: process.env.RAZORPAY_KEY_ID
        });
      } else {
        const paymentIntent = await PaymentService.createPaymentIntent(booking.total_price, req.user.id, bookingId);
        res.json({
          success: true,
          provider: 'stripe',
          clientSecret: paymentIntent.client_secret,
          amount: booking.total_price
        });
      }
    } catch (error) {
      logger.error('Checkout Session error:', error);
      res.status(500).json({ success: false, message: 'Failed to initiate secure checkout' });
    }
  }

  /**
   * 💳 ADD PAYMENT METHOD
   */
  static async addPaymentMethod(req, res) {
    try {
      const { provider, token, type, last4, brand } = req.body;
      if (!provider || !token || !type) {
        return res.status(400).json({ success: false, message: 'Provider, token, and type are required' });
      }

      const method = await PaymentService.addPaymentMethod(req.user.id, {
        provider, token, type, last4, brand
      });

      res.status(201).json({
        success: true,
        message: 'Payment method saved securely',
        data: method
      });
    } catch (error) {
      logger.error('Add Payment Method error:', error);
      res.status(500).json({ success: false, message: 'Failed to save payment method' });
    }
  }

  /**
   * 🏦 GET SAVED PAYMENT METHODS
   */
  static async getPaymentMethods(req, res) {
    try {
      const methods = await require('../config/prisma').payment_methods.findMany({
        where: { user_id: req.user.id },
        orderBy: { created_at: 'desc' }
      });

      res.json({
        success: true,
        data: methods
      });
    } catch (error) {
      logger.error('Get Payment Methods error:', error);
      res.status(500).json({ success: false, message: 'Failed to retrieve payment methods' });
    }
  }
  /**
   * 🏦 SET DEFAULT METHOD
   */
  static async setDefaultMethod(req, res) {
    try {
      const { id } = req.params;
      
      // Transaction to ensure atomicity
      await require('../config/prisma').$transaction([
        require('../config/prisma').payment_methods.updateMany({
          where: { user_id: req.user.id },
          data: { is_default: false }
        }),
        require('../config/prisma').payment_methods.update({
          where: { id: parseInt(id), user_id: req.user.id },
          data: { is_default: true }
        })
      ]);

      res.json({ success: true, message: 'Primary payment method updated' });
    } catch (error) {
      logger.error('Set Default Method error:', error);
      res.status(500).json({ success: false, message: 'Failed to update primary method' });
    }
  }

  /**
   * 📜 GET TRANSACTION HISTORY
   */
  static async getPaymentHistory(req, res) {
    try {
      const history = await require('../config/prisma').bookings.findMany({
        where: { user_id: req.user.id, status: 'completed' },
        include: { parking_spots: true },
        orderBy: { actual_end_time: 'desc' },
        take: 20
      });

      res.json({
        success: true,
        data: history.map(h => ({
          id: h.id,
          amount: h.total_price,
          date: h.actual_end_time,
          spotTitle: h.parking_spots?.title || 'Parking Spot',
          status: h.payment_status,
          surge: h.hours > 0 ? (h.total_price / h.hours).toFixed(2) : 0
        }))
      });
    } catch (error) {
      logger.error('Get Payment History error:', error);
      res.status(500).json({ success: false, message: 'Failed to retrieve history' });
    }
  }

  /**
   * 💸 WITHDRAW EARNINGS
   */
  static async withdrawEarnings(req, res) {
    try {
      const { methodId, amount } = req.body;
      if (!methodId || !amount) {
        return res.status(400).json({ success: false, message: 'Method and amount required' });
      }

      // Check if user has enough balance
      const user = await require('../config/prisma').users.findUnique({
        where: { id: req.user.id }
      });

      if (user.balance < amount) {
        return res.status(400).json({ success: false, message: 'Insufficient balance' });
      }

      // Record withdrawal request (In a real app, this triggers Stripe Payout)
      const withdrawal = await require('../config/prisma').withdrawals.create({
        data: {
          user_id: req.user.id,
          amount: parseFloat(amount),
          payment_method_id: parseInt(methodId),
          status: 'pending'
        }
      });

      // Deduct balance
      await require('../config/prisma').users.update({
        where: { id: req.user.id },
        data: { balance: { decrement: parseFloat(amount) } }
      });

      res.json({ success: true, message: 'Withdrawal initiated', data: withdrawal });
    } catch (error) {
      logger.error('Withdrawal Controller Error:', error);
      res.status(500).json({ success: false, message: 'Failed to initiate withdrawal' });
    }
  }

  /**
   * 💸 REFUND PAYMENT
   */
  static async refundPayment(req, res) {
    try {
      const { bookingId, amount } = req.body;
      const result = await PaymentService.processRefund(bookingId, amount);
      res.json({ success: true, message: 'Refund processed successfully', data: result });
    } catch (error) {
      logger.error('Refund Controller Error:', error);
      res.status(500).json({ success: false, message: error.message || 'Refund failed' });
    }
  }

  /**
   * 🛒 CREATE RAZORPAY ORDER
   */
  static async createRazorpayOrder(req, res) {
    try {
      if (req.user.role !== 'finder') {
        return res.status(403).json({ success: false, message: 'Only finders can process payments' });
      }

      const { bookingId } = req.body;
      if (!bookingId) {
        return res.status(400).json({ success: false, message: 'Booking ID is required' });
      }

      const booking = await Booking.findById(bookingId);

      if (!booking) {
        return res.status(404).json({ success: false, message: 'Booking not found' });
      }
      if (booking.user_id !== req.user.id) {
         return res.status(403).json({ success: false, message: 'Unauthorized access to this booking' });
      }

      const order = await PaymentService.createRazorpayOrder(booking.total_price, req.user.id, bookingId);

      res.json({
        success: true,
        order_id: order.orderId,
        amount: order.amount,
        currency: order.currency,
        key_id: process.env.RAZORPAY_KEY_ID
      });
    } catch (error) {
      logger.error('Razorpay Create Order error:', error);
      res.status(500).json({ success: false, message: 'Failed to initiate Razorpay checkout' });
    }
  }

  /**
   * ✅ VERIFY RAZORPAY PAYMENT
   */
  static async verifyRazorpayPayment(req, res) {
    try {
      if (req.user.role !== 'finder') {
        return res.status(403).json({ success: false, message: 'Only finders can process payments' });
      }

      const { bookingId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
      
      const booking = await Booking.findById(bookingId);
      if (!booking) {
        return res.status(404).json({ success: false, message: 'Booking not found' });
      }
      if (booking.user_id !== req.user.id) {
         return res.status(403).json({ success: false, message: 'Unauthorized access to this booking' });
      }

      const verificationResult = await PaymentService.verifyRazorpayPayment(
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        bookingId
      );

      res.json({
        success: true,
        message: 'Payment verified and saved successfully',
        paymentId: verificationResult.paymentId
      });
    } catch (error) {
      logger.error('Razorpay Verify Payment error:', error);
      res.status(500).json({ success: false, message: error.message || 'Failed to verify Razorpay payment' });
    }
  }

  /**
   * ✅ VERIFY STRIPE PAYMENT
   */
  static async verifyStripePayment(req, res) {
    try {
      if (req.user.role !== 'finder') {
        return res.status(403).json({ success: false, message: 'Only finders can process payments' });
      }

      const { bookingId, paymentIntentId } = req.body;
      if (!bookingId || !paymentIntentId) {
        return res.status(400).json({ success: false, message: 'Booking ID and PaymentIntent ID are required' });
      }

      const booking = await require('../config/prisma').bookings.update({
        where: { id: parseInt(bookingId) },
        data: {
          payment_id: paymentIntentId,
          payment_status: 'paid',
          updated_at: new Date()
        },
        include: {
          parking_spots: true
        }
      });

      // Trigger online payout to Spotter
      try {
        if (booking && booking.parking_spots) {
          const PayoutService = require('../services/payments/PayoutService');
          const spotterEarning = booking.spotter_earning || 0;
          const spotterId = booking.parking_spots.spotter_id;
          if (spotterId && spotterEarning > 0) {
            await PayoutService.processBookingPayout(bookingId, spotterEarning, spotterId);
            logger.info(`Payout processed: ₹${spotterEarning} to spotter ${spotterId} for booking ${bookingId}`);
          }
        }
      } catch (payoutErr) {
        logger.error(`Failed to process payout for booking ${bookingId} after Stripe verification:`, payoutErr);
      }

      res.json({
        success: true,
        message: 'Stripe payment verified and saved successfully'
      });
    } catch (error) {
      logger.error('Stripe Verify Payment error:', error);
      res.status(500).json({ success: false, message: 'Failed to verify Stripe payment' });
    }
  }

  /**
   * 🛒 CREATE CLEAR DUES ORDER
   */
  static async createClearDuesOrder(req, res) {
    try {
      const user = await require('../config/prisma').users.findUnique({
        where: { id: req.user.id }
      });
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });
      
      const dues = Math.abs(Number(user.balance));
      if (user.balance >= 0) {
        return res.status(400).json({ success: false, message: 'No dues to clear' });
      }

      const receipt = `dues_${req.user.id}_${Date.now()}`;
      const order = await require('../services/payments/RazorpayAdapter').createOrder(dues, receipt, {
        user_id: req.user.id,
        purpose: 'clear_dues'
      });

      res.json({
        success: true,
        order_id: order.orderId,
        amount: order.amount,
        currency: order.currency,
        key_id: process.env.RAZORPAY_KEY_ID
      });
    } catch (err) {
      logger.error('Clear Dues Order Error:', err);
      res.status(500).json({ success: false, message: 'Failed to create dues order' });
    }
  }

  /**
   * ✅ VERIFY CLEAR DUES PAYMENT
   */
  static async verifyClearDuesPayment(req, res) {
    try {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
      const isValid = await require('../services/payments/RazorpayAdapter').verifySignature(
        razorpay_order_id, razorpay_payment_id, razorpay_signature
      );
      if (!isValid) return res.status(400).json({ success: false, message: 'Invalid payment signature' });

      // Reset balance to 0
      await require('../config/prisma').users.update({
        where: { id: req.user.id },
        data: { balance: 0 }
      });

      res.json({ success: true, message: 'Dues cleared successfully' });
    } catch (err) {
      logger.error('Verify Dues Payment Error:', err);
      res.status(500).json({ success: false, message: 'Failed to verify dues payment' });
    }
  }
}

module.exports = PaymentController;

