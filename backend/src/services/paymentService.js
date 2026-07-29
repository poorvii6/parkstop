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
      const receipt = bookingId ? `booking_${bookingId}_${Date.now()}` : `topup_${userId}_${Date.now()}`;
      const order = await razorpayAdapter.createOrder(amount, receipt, {
        user_id: userId.toString(),
        booking_id: bookingId ? bookingId.toString() : 'wallet_topup'
      });
      return order;
    } catch (error) {
      logger.error('Error creating Razorpay Order:', error);
      throw new Error('Failed to create Razorpay order.');
    }
  }

  /**
   * Shared settlement: atomically claim the booking's paid transition, then
   * clear arrears and trigger the spotter payout. Returns null if another
   * caller already settled it (idempotent). Used by BOTH the client verify
   * path and the webhook, so their side-effects can never diverge or double.
   */
  static async _finalizeClaimedBooking(bookingId, paymentId) {
    const claimed = await prisma.bookings.updateMany({
      where: { id: parseInt(bookingId), payment_status: { not: 'paid' } },
      data: {
        payment_id: paymentId,
        payment_status: 'paid',
        updated_at: new Date()
      }
    });
    if (claimed.count === 0) return null;

    const updatedBooking = await prisma.bookings.findUnique({
      where: { id: parseInt(bookingId) },
      include: { parking_spots: true, users: true }
    });

    // Clear any arrears the Finder had, since they just paid for them in the combined Order
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
      logger.error(`Failed to process payout for booking ${bookingId} after settlement:`, payoutErr);
    }

    return updatedBooking;
  }

  /**
   * ✅ WEBHOOK SETTLEMENT (server-to-server, authoritative)
   * Called for Razorpay's `payment.captured` events. Does NOT trust anything
   * from the app: the payment entity comes from a signature-verified webhook,
   * the booking is recovered from the ORDER's notes (set at order creation),
   * and the captured amount must equal the order amount. Idempotent with the
   * client verify path via the shared atomic claim.
   */
  static async settleFromWebhook(paymentEntity) {
    if (!paymentEntity || paymentEntity.status !== 'captured') {
      return { handled: false, reason: 'not captured' };
    }

    const order = await razorpayAdapter.fetchOrder(paymentEntity.order_id);
    const bookingId = order?.notes?.booking_id;
    if (!bookingId || bookingId === 'wallet_topup') {
      logger.info(`Webhook: payment ${paymentEntity.id} is not a booking payment (notes: ${JSON.stringify(order?.notes || {})}) — skipping`);
      return { handled: false, reason: 'no booking' };
    }

    // The captured amount must be exactly what the order was created for.
    if (Number(paymentEntity.amount) !== Number(order.amount)) {
      logger.error(`Webhook AMOUNT MISMATCH for booking ${bookingId}: order ${order.amount} vs captured ${paymentEntity.amount}`);
      throw new Error('Webhook amount mismatch');
    }

    const updatedBooking = await PaymentService._finalizeClaimedBooking(bookingId, paymentEntity.id);
    if (!updatedBooking) {
      logger.info(`Webhook: booking ${bookingId} already settled — idempotent ack`);
      return { handled: true, alreadySettled: true };
    }

    logger.info(`Webhook settled booking ${bookingId} via payment ${paymentEntity.id}`);
    return { handled: true };
  }

  /**
   * ✅ VERIFY RAZORPAY PAYMENT
   * Validates the payment signature and marks the booking as paid.
   */
  static async verifyRazorpayPayment(orderId, paymentId, signature, bookingId) {
    try {
      // 1. Fetch booking to check status and calculate expected price
      const booking = await prisma.bookings.findUnique({
        where: { id: parseInt(bookingId) },
        include: { users: true }
      });

      if (!booking) {
        throw new Error('Booking not found');
      }

      if (booking.payment_status === 'paid') {
        logger.info(`Payment verification for booking ${bookingId} was already processed (already paid)`);
        return { success: true, paymentId: booking.payment_id };
      }

      // 2. Verify signature.
      //
      // `mock_upi_intent` marks a booking PAID without any money moving. It is
      // a local-testing shim, and the only thing that ever stood between it and
      // free parking was NODE_ENV — one misconfigured variable away from a
      // production hole, exactly like the IGNORE_RATE_LIMITS gap.
      //
      // Now it needs TWO independent conditions, and neither is satisfiable in
      // production: an explicit opt-in flag AND a hard NODE_ENV check. Setting
      // ALLOW_MOCK_PAYMENTS on the production service does nothing.
      const isMockSignature = signature === 'mock_upi_intent';
      const mockAllowed =
        process.env.NODE_ENV !== 'production' &&
        process.env.ALLOW_MOCK_PAYMENTS === 'true';

      if (isMockSignature && !mockAllowed) {
        logger.error(
          `REJECTED mock payment signature for booking ${bookingId} — mock payments are not enabled in this environment`
        );
        throw new Error('Payment signature verification failed.');
      }

      const isValid = (isMockSignature && mockAllowed)
        ? true
        : razorpayAdapter.verifyPaymentSignature(orderId, paymentId, signature);

      if (!isValid) {
        throw new Error('Payment signature verification failed.');
      }

      if (isMockSignature && mockAllowed) {
        logger.warn(`Booking ${bookingId} settled with a MOCK payment (no money moved)`);
      }

      // 3. Fetch payment details from Razorpay
      let paymentDetails;
      const user = booking.users;
      const arrears = (user && user.balance < 0) ? Math.abs(Number(user.balance)) : 0;
      const expectedAmountPaise = Math.round((Number(booking.total_price) + arrears) * 100);

      if (isMockSignature && mockAllowed) {
        paymentDetails = {
          status: 'captured',
          amount: expectedAmountPaise
        };
      } else {
        paymentDetails = await razorpayAdapter.fetchPayment(paymentId);
      }

      // 4. Verify payment status is captured
      if (paymentDetails.status !== 'captured') {
        throw new Error(`Payment not captured. Status: ${paymentDetails.status}`);
      }

      // 5. Verify actual amount matches the expected amount
      const actualAmountPaise = Number(paymentDetails.amount);
      if (actualAmountPaise !== expectedAmountPaise) {
        throw new Error(`Amount mismatch: expected ${expectedAmountPaise} paise, got ${actualAmountPaise} paise`);
      }

      // 6. Mark the booking as paid — ATOMIC CLAIM. The conditional updateMany
      // means exactly ONE caller (client verify or webhook, even concurrently)
      // wins the transition to 'paid'; everyone else sees count 0 and returns
      // idempotently. This closes the double-settlement race.
      const updatedBooking = await PaymentService._finalizeClaimedBooking(bookingId, paymentId);
      if (!updatedBooking) {
        logger.info(`Booking ${bookingId} was settled concurrently — idempotent return`);
        return { success: true, paymentId };
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
