const PaymentService = require('../services/paymentService');
const logger = require('../utils/logger');
const Booking = require('../models/Booking');
const prisma = require('../config/prisma');

class PaymentController {

  /**
   * 🛒 INITIATE CHECKOUT
   * Called by the frontend right before paying for a reservation.
   */
  static async createCheckoutSession(req, res) {
    try {
      if (req.user.role.toLowerCase() !== 'finder') {
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

      // Fetch user to check for arrears
      const user = await prisma.users.findUnique({
        where: { id: req.user.id }
      });
      const arrears = user.balance < 0 ? Math.abs(Number(user.balance)) : 0;
      const finalAmountToCharge = Number(booking.total_price) + arrears;

      // Find the spot and the spotter
      const spot = await prisma.parking_spots.findUnique({
        where: { id: booking.spot_id },
        include: { users: true }
      });
      const spotter = spot?.users;

      // Enforce Razorpay exclusively as the active gateway for the Indian market
      const useRazorpay = true;

      if (useRazorpay) {
        const order = await PaymentService.createRazorpayOrder(finalAmountToCharge, req.user.id, bookingId);
        res.json({
          success: true,
          provider: 'razorpay',
          order_id: order.orderId,
          amount: order.amount,
          currency: order.currency,
          key_id: process.env.RAZORPAY_KEY_ID,
          base_price: booking.total_price,
          arrears_included: arrears
        });
      } else {
        const paymentIntent = await PaymentService.createPaymentIntent(finalAmountToCharge, req.user.id, bookingId);
        res.json({
          success: true,
          provider: 'stripe',
          clientSecret: paymentIntent.client_secret,
          amount: finalAmountToCharge,
          base_price: booking.total_price,
          arrears_included: arrears
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
      const methods = await prisma.payment_methods.findMany({
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
      await prisma.$transaction([
        prisma.payment_methods.updateMany({
          where: { user_id: req.user.id },
          data: { is_default: false }
        }),
        prisma.payment_methods.update({
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
   * 💸 WITHDRAW EARNINGS
   */
  static async withdrawEarnings(req, res) {
    try {
      const { methodId } = req.body;
      // STRICT amount validation. `!amount` alone let a NEGATIVE amount through,
      // and decrementing a negative amount INCREASES the wallet balance — a
      // free-money exploit. Must be a finite positive number, sane bounds,
      // normalised to 2dp.
      const amount = Math.round(Number(req.body.amount) * 100) / 100;
      if (!methodId || !Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
        return res.status(400).json({ success: false, message: 'A valid positive amount and method are required' });
      }

      // Use a transaction to prevent race conditions
      const result = await prisma.$transaction(async (tx) => {
        // Fetch user inside transaction
        const user = await tx.users.findUnique({
          where: { id: req.user.id }
        });

        if (!user || user.balance < amount) {
          throw new Error('Insufficient balance');
        }

        // Record withdrawal request
        const withdrawal = await tx.withdrawals.create({
          data: {
            user_id: req.user.id,
            amount: parseFloat(amount),
            payment_method_id: parseInt(methodId),
            status: 'pending'
          }
        });

        // Deduct balance
        const updatedUser = await tx.users.update({
          where: { id: req.user.id },
          data: { balance: { decrement: parseFloat(amount) } }
        });

        // Double check against negative balance
        if (updatedUser.balance < 0) {
          throw new Error('Insufficient balance');
        }

        return withdrawal;
      });

      // ACTUALLY MOVE THE MONEY.
      //
      // Until now this endpoint only wrote a row with status 'pending' and
      // decremented the wallet. Nothing anywhere processed that row — there is
      // no admin endpoint and no job — so the spotter watched their balance
      // fall with no transfer and no record: the dashboard's payout history
      // reads the `payouts` table, while this wrote to `withdrawals`.
      //
      // The button that calls this is only shown when a real payout rail is
      // linked, so a fund account exists by the time we get here. PayoutService
      // sends it, records it in `payouts` (so it appears in history), and on
      // failure credits the balance back — which is exactly the right
      // compensation, since it was already debited above.
      try {
        const PayoutService = require('../services/payments/PayoutService');
        const spotter = await prisma.users.findUnique({
          where: { id: req.user.id },
          select: { razorpay_fund_account_id: true, payout_mode: true },
        });

        if (spotter?.razorpay_fund_account_id) {
          const payout = await PayoutService.createPayout({
            fundAccountId: spotter.razorpay_fund_account_id,
            amount,
            mode: spotter.payout_mode === 'bank' ? 'IMPS' : 'UPI',
            narration: 'ParkStop withdrawal',
            userId: req.user.id,
            bookingId: null,
          });

          const sent = payout && payout.status !== 'failed_queued';
          await prisma.withdrawals.update({
            where: { id: result.id },
            data: { status: sent ? 'processing' : 'failed' },
          });

          return res.json({
            success: true,
            message: sent
              ? 'Withdrawal sent to your account'
              : 'Withdrawal could not be sent — the amount has been returned to your wallet',
            data: { ...result, status: sent ? 'processing' : 'failed' },
          });
        }

        // No rail linked. Leave it pending for manual settlement rather than
        // claiming it is on its way.
        logger.warn(`Withdrawal ${result.id} left pending: user ${req.user.id} has no fund account`);
        return res.json({
          success: true,
          message: 'Withdrawal requested — it will be reviewed and paid manually',
          data: result,
        });
      } catch (payoutErr) {
        logger.error(`Withdrawal ${result.id} payout failed:`, payoutErr);
        // Give the money back rather than leaving it in limbo.
        await prisma.users
          .update({ where: { id: req.user.id }, data: { balance: { increment: amount } } })
          .catch((e) => logger.error('CRITICAL: could not refund failed withdrawal:', e));
        await prisma.withdrawals
          .update({ where: { id: result.id }, data: { status: 'failed' } })
          .catch(() => {});
        return res.status(502).json({
          success: false,
          message: 'Could not complete the withdrawal. The amount is back in your wallet.',
        });
      }
    } catch (error) {
      if (error.message === 'Insufficient balance') {
        return res.status(400).json({ success: false, message: 'Insufficient balance' });
      }
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
      if (req.user.role.toLowerCase() !== 'finder') {
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

      // Charge the spot fee plus the advance fee. The verification step checks
      // the captured amount against exactly this sum, so the two must agree.
      const payable = Number(booking.total_price) + Number(booking.advance_fee || 0);

      const order = await PaymentService.createRazorpayOrder(payable, req.user.id, bookingId);

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
      if (req.user.role.toLowerCase() !== 'finder') {
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
      if (req.user.role.toLowerCase() !== 'finder') {
        return res.status(403).json({ success: false, message: 'Only finders can process payments' });
      }

      const { bookingId, paymentIntentId } = req.body;
      if (!bookingId || !paymentIntentId) {
        return res.status(400).json({ success: false, message: 'Booking ID and PaymentIntent ID are required' });
      }

      // Ownership: a finder may only settle their OWN booking. Without this,
      // any authenticated finder could mark ANY booking paid (and trigger that
      // spotter's payout) with an arbitrary paymentIntentId.
      const existing = await prisma.bookings.findUnique({ where: { id: parseInt(bookingId) } });
      if (!existing) {
        return res.status(404).json({ success: false, message: 'Booking not found' });
      }
      if (existing.user_id !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Unauthorized access to this booking' });
      }
      if (existing.payment_status === 'paid') {
        return res.json({ success: true, message: 'Payment already recorded' });
      }

      // Never trust a client-supplied PaymentIntent id: verify it with Stripe,
      // confirm it actually succeeded and was created for THIS booking.
      const stripeAdapter = require('../services/payments/StripeAdapter');
      const intent = await stripeAdapter.retrievePaymentIntent(paymentIntentId);
      if (!intent || intent.status !== 'succeeded') {
        return res.status(400).json({ success: false, message: 'Stripe payment not completed' });
      }
      if (String(intent.metadata?.booking_id || '') !== String(bookingId)) {
        return res.status(400).json({ success: false, message: 'Payment does not match this booking' });
      }

      const booking = await prisma.bookings.update({
        where: { id: parseInt(bookingId) },
        data: {
          payment_id: paymentIntentId,
          payment_status: 'paid',
          // Same basis as the Razorpay path: what this booking cost, so the
          // refund ladder and the checkout floor have a number to work from.
          amount_paid: Number(existing.total_price || 0) + Number(existing.advance_fee || 0),
          updated_at: new Date()
        },
        include: {
          parking_spots: true
        }
      });

      // Notify the Spotter in realtime that payment landed, so their checkout
      // screen closes immediately instead of waiting for a poll.
      try {
        if (booking?.parking_spots?.spotter_id) {
          const { emitToUser } = require('../config/socket');
          emitToUser(booking.parking_spots.spotter_id, 'booking:paid', {
            bookingId: parseInt(bookingId),
          });
        }
      } catch (emitErr) {
        logger.error('Failed to emit booking:paid', emitErr);
      }

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
      const user = await prisma.users.findUnique({
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
      const RazorpayAdapter = require('../services/payments/RazorpayAdapter');
      const isValid = RazorpayAdapter.verifyPaymentSignature(
        razorpay_order_id, razorpay_payment_id, razorpay_signature
      );
      if (!isValid) return res.status(400).json({ success: false, message: 'Invalid payment signature' });

      const user = await prisma.users.findUnique({ where: { id: req.user.id } });
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });
      const dues = user.balance < 0 ? Math.abs(Number(user.balance)) : 0;
      if (dues <= 0) return res.json({ success: true, message: 'No dues to clear' });

      // A valid signature only proves *some* payment happened — not that it was
      // for THESE dues. Bind it: the order must have been created for clear_dues
      // by this user, the payment must be captured, and it must cover the dues.
      const order = await RazorpayAdapter.fetchOrder(razorpay_order_id);
      const payment = await RazorpayAdapter.fetchPayment(razorpay_payment_id);
      const paidPaise = Number(payment?.amount || 0);
      const duesPaise = Math.round(dues * 100);
      const purposeOk =
        order?.notes?.purpose === 'clear_dues' &&
        String(order?.notes?.user_id) === String(req.user.id);
      if (!payment || payment.status !== 'captured' || !purposeOk || paidPaise < duesPaise) {
        return res.status(400).json({ success: false, message: 'Payment does not match the outstanding dues' });
      }

      // Credit exactly the dues that were owed (never more).
      await prisma.users.update({
        where: { id: req.user.id },
        data: { balance: { increment: dues } }
      });

      res.json({ success: true, message: 'Dues cleared successfully' });
    } catch (err) {
      logger.error('Verify Dues Payment Error:', err);
      res.status(500).json({ success: false, message: 'Failed to verify dues payment' });
    }
  }

  /**
   * 💳 WALLET TOP-UP FOR FINDERS
   */
  static async topUpWallet(req, res) {
    try {
      if (req.user.role.toLowerCase() !== 'finder') {
        return res.status(403).json({ success: false, message: 'Only finders can top up wallet' });
      }

      const { amount } = req.body;
      if (!amount || amount < 50 || amount > 10000) {
        return res.status(400).json({ success: false, message: 'Amount must be between ₹50 and ₹10,000' });
      }

      const order = await PaymentService.createRazorpayOrder(amount, req.user.id, null);

      res.json({
        success: true,
        data: {
          order_id: order.orderId,
          amount: order.amount,
          currency: 'INR',
          purpose: 'wallet_topup'
        }
      });
    } catch (error) {
      logger.error('Wallet top-up error:', error);
      res.status(500).json({ success: false, message: 'Failed to initiate top-up' });
    }
  }

  static async confirmWalletTopUp(req, res) {
    try {
      const { order_id, payment_id, signature } = req.body;
      const RazorpayAdapter = require('../services/payments/RazorpayAdapter');

      const isValid = RazorpayAdapter.verifyPaymentSignature(order_id, payment_id, signature);
      if (!isValid) {
        return res.status(400).json({ success: false, message: 'Payment verification failed' });
      }

      // Never trust the client-supplied amount. Fetch the real payment + order
      // and credit exactly what Razorpay actually captured, for a wallet-top-up
      // order that belongs to this user. (The old code credited req.body.amount,
      // so a ₹50 payment could be replayed to claim up to ₹10,000.)
      const order = await RazorpayAdapter.fetchOrder(order_id);
      const payment = await RazorpayAdapter.fetchPayment(payment_id);
      const ownsOrder = String(order?.notes?.user_id) === String(req.user.id);
      const isTopup =
        order?.notes?.booking_id === 'wallet_topup' ||
        order?.notes?.purpose === 'wallet_topup';
      if (!payment || payment.status !== 'captured' || payment.order_id !== order_id || !ownsOrder || !isTopup) {
        return res.status(400).json({ success: false, message: 'Payment not captured or does not match a wallet top-up' });
      }

      const creditRupees = Number(payment.amount) / 100;
      await prisma.users.update({
        where: { id: req.user.id },
        data: { balance: { increment: creditRupees } }
      });

      res.json({ success: true, message: `₹${creditRupees} added to your wallet successfully` });
    } catch (error) {
      logger.error('Wallet confirm error:', error);
      res.status(500).json({ success: false, message: 'Failed to confirm top-up' });
    }
  }
}

module.exports = PaymentController;

