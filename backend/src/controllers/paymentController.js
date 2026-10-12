const PaymentService = require('../services/paymentService');
const { hasRole } = require('../utils/roles');
const logger = require('../utils/logger');
const Booking = require('../models/Booking');
const prisma = require('../config/prisma');

class PaymentController {

  /**
   * 📜 GET TRANSACTION HISTORY
   */
  static async getPaymentHistory(req, res) {
    try {
      const history = await prisma.bookings.findMany({
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
   * 🛒 CREATE RAZORPAY ORDER
   */
  static async createRazorpayOrder(req, res) {
    try {
      if (!hasRole(req.user, 'FINDER')) {
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

      if (booking.payment_status === 'paid') {
        return res.status(409).json({ success: false, message: 'This booking is already paid.' });
      }
      if (['cancelled', 'expired'].includes(String(booking.status))) {
        return res.status(409).json({ success: false, message: `This booking is ${booking.status} and cannot be paid.` });
      }

      // Spot fee + advance fee + any old unpaid dues. The verify step checks the
      // payment against this exact order, and clears only the dues recorded here.
      const user = await prisma.users.findUnique({ where: { id: req.user.id } });
      const { arrears, total } = PaymentService.computePayable(booking, user);
      if (!(total > 0)) {
        return res.status(400).json({ success: false, message: 'Nothing to pay for this booking.' });
      }

      const order = await PaymentService.createRazorpayOrder(total, req.user.id, bookingId, { arrears });

      res.json({
        success: true,
        order_id: order.orderId,
        amount: order.amount,
        currency: order.currency,
        key_id: process.env.RAZORPAY_KEY_ID,
        breakdown: { booking: total - arrears, previous_dues: arrears }
      });
    } catch (error) {
      logger.error('Razorpay Create Order error:', error);
      res.status(500).json({ success: false, message: 'Failed to initiate Razorpay checkout' });
    }
  }

  /**
   * 🔳 CREATE BOOKING PAYMENT QR (credits ParkStop, not the spotter's UPI)
   */
  static async createBookingQr(req, res) {
    try {
      const { bookingId } = req.body;
      if (!bookingId) {
        return res.status(400).json({ success: false, message: 'bookingId is required' });
      }
      const qr = await PaymentService.createBookingQr(bookingId, req.user.id);
      return res.json({ success: true, data: qr });
    } catch (error) {
      logger.error('createBookingQr error:', error);
      return res.status(400).json({ success: false, message: error.message || 'Failed to create payment QR' });
    }
  }

  /**
   * 🔔 RAZORPAY WEBHOOK (server-to-server, no auth — authenticated by HMAC)
   * Authoritative payment confirmation: settles bookings even if the app died
   * right after the user paid. Razorpay retries non-2xx responses, so we only
   * 2xx after handling (or deliberately ignoring) the event.
   */
  static async razorpayWebhook(req, res) {
    try {
      if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
        logger.error('Webhook received but RAZORPAY_WEBHOOK_SECRET is not configured');
        return res.status(500).json({ success: false });
      }

      const signature = req.headers['x-razorpay-signature'];
      const rawBody = req.rawBody; // captured by express.json verify hook
      const razorpayAdapter = require('../services/payments/RazorpayAdapter');
      if (!razorpayAdapter.verifyWebhookSignature(rawBody, signature)) {
        logger.warn('Webhook REJECTED: invalid signature');
        return res.status(400).json({ success: false, message: 'Invalid signature' });
      }

      const event = req.body?.event;
      if (event === 'payment.captured') {
        const entity = req.body?.payload?.payment?.entity;
        const result = await PaymentService.settleFromWebhook(entity);
        return res.json({ received: true, ...result });
      }

      if (event === 'qr_code.credited') {
        const qrEntity = req.body?.payload?.qr_code?.entity;
        const paymentEntity = req.body?.payload?.payment?.entity;
        const result = await PaymentService.settleFromQrCredit(paymentEntity, qrEntity);
        return res.json({ received: true, ...result });
      }

      // Acknowledge everything else so Razorpay stops retrying events we
      // deliberately don't act on (payment.failed, order.paid, etc.).
      logger.info(`Webhook event ignored: ${event}`);
      return res.json({ received: true, ignored: event });
    } catch (error) {
      logger.error('Razorpay webhook error:', error);
      // Non-2xx => Razorpay retries with backoff — exactly what we want for
      // transient DB/network failures.
      return res.status(500).json({ success: false });
    }
  }

  /**
   * ✅ VERIFY RAZORPAY PAYMENT
   */
  static async verifyRazorpayPayment(req, res) {
    try {
      if (!hasRole(req.user, 'FINDER')) {
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
        bookingId,
        req.user.id
      );

      res.json({
        success: true,
        message: 'Payment verified and saved successfully',
        paymentId: verificationResult.paymentId
      });
    } catch (error) {
      logger.error('Razorpay Verify Payment error:', error);
      res.status(400).json({ success: false, message: error.message || 'Failed to verify Razorpay payment' });
    }
  }

}

module.exports = PaymentController;

