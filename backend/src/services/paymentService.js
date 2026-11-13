const razorpayAdapter = require('./payments/RazorpayAdapter');
const prisma = require('../config/prisma');
const logger = require('../utils/logger');
const NotificationService = require('./notificationService');

class PaymentService {

  /**
   * 🛒 CREATE RAZORPAY ORDER
   * Creates a Razorpay order that the frontend uses to launch the checkout UI.
   */
  /**
   * What a finder owes for a booking, in rupees. ONE function used by order
   * creation and by every settlement check, so they can never disagree.
   *   base    = spot price + advance fee (what this booking costs)
   *   arrears = the finder's unpaid dues from earlier bookings (negative balance)
   */
  static computePayable(booking, user) {
    // What this booking costs, LESS whatever has already been collected for it.
    //
    // The subtraction is what makes a second payment possible. A driver who
    // overstays has total_price raised to the time they actually used, but they
    // have already paid for the window they booked. Without this, the top-up
    // charge would be the whole new total on top of what they paid.
    // For a booking that has never been paid, amount_paid is 0 and nothing changes.
    const gross = Number(booking?.total_price || 0) + Number(booking?.advance_fee || 0);
    const collected = Math.max(0, Number(booking?.amount_paid || 0));
    const base = Math.max(0, Math.round((gross - collected) * 100) / 100);
    const balance = Number(user?.balance || 0);
    const arrears = balance < 0 ? Math.abs(balance) : 0;
    return { base, arrears, total: Math.round((base + arrears) * 100) / 100 };
  }

  static async createRazorpayOrder(amount, userId, bookingId, extraNotes = {}) {
    try {
      const receipt = bookingId ? `booking_${bookingId}_${Date.now()}` : `topup_${userId}_${Date.now()}`;
      const order = await razorpayAdapter.createOrder(amount, receipt, {
        user_id: userId.toString(),
        booking_id: bookingId ? bookingId.toString() : 'wallet_topup',
        ...Object.fromEntries(Object.entries(extraNotes).map(([k, v]) => [k, String(v)])),
      });
      return order;
    } catch (error) {
      logger.error('Error creating Razorpay Order:', error);
      throw new Error('Failed to create Razorpay order.');
    }
  }

  /**
   * @param arrearsPaid rupees of OLD dues included in this payment (from the
   *   order/QR notes). Only that much debt is cleared — never more.
   */
  static async _finalizeClaimedBooking(bookingId, paymentId, arrearsPaid = 0) {
    const before = await prisma.bookings.findUnique({
      where: { id: parseInt(bookingId) },
      select: { total_price: true, advance_fee: true, status: true }
    });

    // What this booking itself cost, excluding any arrears cleared in the same
    // order — those settle an older debt and must not count as money paid
    // towards this booking, or a refund would hand back more than was taken.
    const paidForThisBooking =
      Number(before?.total_price || 0) + Number(before?.advance_fee || 0);

    const claimed = await prisma.bookings.updateMany({
      where: { id: parseInt(bookingId), payment_status: { not: 'paid' } },
      data: {
        payment_id: paymentId,
        payment_status: 'paid',
        // The floor used at checkout and the basis for every refund figure.
        amount_paid: paidForThisBooking,
        updated_at: new Date()
      }
    });
    if (claimed.count === 0) return null;

    const updatedBooking = await prisma.bookings.findUnique({
      where: { id: parseInt(bookingId) },
      include: { parking_spots: true, users: true }
    });

    // Clear ONLY the arrears this payment actually included. Clearing the full
    // balance here used to forgive debt that was never paid (e.g. webhook
    // settlement of an order created without arrears).
    const paidArrears = Math.max(0, Number(arrearsPaid) || 0);
    if (paidArrears > 0 && updatedBooking.users && updatedBooking.users.balance < 0) {
      const arrearsToClear = Math.min(paidArrears, Math.abs(Number(updatedBooking.users.balance)));
      await prisma.users.update({
        where: { id: updatedBooking.user_id },
        data: { balance: { increment: arrearsToClear } }
      });
      logger.info(`Cleared ₹${arrearsToClear} arrears for user ${updatedBooking.user_id} during checkout of booking ${bookingId}`);
    }

    // Tell the owner their money has arrived.
    //
    // Placed here because this is the ONE point every payment passes through
    // -- the app's verify call, the Razorpay webhook and a scanned QR all end
    // up in this function -- and because it is after the atomic claim, so a
    // retry or a second caller that loses the race sends nothing.
    //
    // It matters most for a payment made mid-booking: without it, an owner
    // reaches the end of the session with no idea they have been paid and
    // raises their QR. Best effort, never blocking the settlement.
    try {
      const paidSpot = updatedBooking?.parking_spots;
      if (paidSpot?.spotter_id) {
        await NotificationService.notifyBookingPaid(
          paidSpot.spotter_id, updatedBooking, paidSpot, paidForThisBooking,
        );
      }
    } catch (notifyErr) {
      logger.warn(`Paid-notification failed for booking ${bookingId}: ${notifyErr?.message}`);
    }

    // Trigger online payout to Spotter.
    //
    // NOT while the booking is still 'reserved'. Payment used to happen only at
    // checkout, so paying out the moment money landed was safe. With prepaid
    // bookings the money arrives before the car does — paying the owner then
    // would send real money out of the business for a booking the finder can
    // still cancel, and the refund would have nothing to claw back from.
    // The owner is paid when the session actually completes.
    // The owner is paid when the SESSION is over, never before.
    //
    // This used to defer only for a 'reserved' booking, back when that was the
    // one way to pay early. A driver can now settle at any point in a live
    // booking, and paying while 'active' credited the owner there and then --
    // on a figure that was not final. If the driver then overstayed, the bill
    // rose, the driver paid the difference, and the owner got none of it:
    // payouts.booking_id is UNIQUE and processBookingPayout had already run.
    // A 1-hour booking used for 3 left the owner on 85 of the 240 they had
    // earned, with ParkStop holding the rest.
    //
    // Waiting for 'completed' means spotter_earning has been recomputed
    // against the time actually used, and the top-up payment itself lands
    // here with the booking completed, which is what triggers the credit.
    const sessionOver = updatedBooking?.status === 'completed';

    if (!sessionOver) {
      logger.info(
        `Booking ${bookingId} paid while ${updatedBooking?.status} — payout deferred until the session completes`
      );
    } else {
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
    }

    return updatedBooking;
  }

  /**
   * 🔳 CREATE A BOOKING PAYMENT QR (credits ParkStop)
   * Amount is computed SERVER-SIDE (price + finder arrears) — the client cannot
   * influence it. Replaces the old QR that paid the spotter's personal UPI.
   */
  static async createBookingQr(bookingId, requesterId) {
    const booking = await prisma.bookings.findUnique({
      where: { id: parseInt(bookingId) },
      include: { users: true, parking_spots: true }
    });
    if (!booking) throw new Error('Booking not found');
    if (booking.payment_status === 'paid') throw new Error('This booking is already paid');

    // A booking that never happened must not be collectable.
    //
    // This had no status check at all, so an owner could type the id of a
    // cancelled or expired booking into the QR screen and take money for
    // parking that never took place -- and because a QR credits ParkStop, the
    // refund would come out of ParkStop. The order route
    // (paymentController.createRazorpayOrder) has always refused these; the QR
    // route is the same money by another door and now refuses them too.
    if (['cancelled', 'expired'].includes(String(booking.status))) {
      throw new Error(`This booking is ${booking.status} and cannot be paid.`);
    }

    // The owner's QR is a CHECKOUT instrument, nothing else.
    //
    // It exists for the moment the driver is standing there at the end: the
    // session is over, the owner has confirmed it, and the bill is final. Any
    // earlier and the owner is collecting against a figure that can still
    // change -- a driver who stays longer owes more, one who cancels is owed a
    // refund -- and an owner with a QR in hand can lean on a driver to pay
    // before they have parked.
    //
    // A driver who wants to pay earlier still can, through the app's own
    // Razorpay checkout. That keeps one direction of travel: money reaches
    // ParkStop first, and ParkStop pays the owner once the session completes.
    if (String(booking.status) !== 'completed') {
      throw new Error('This session is not finished yet. Confirm the driver has left, then take payment.');
    }

    // Only the booking's finder or the spot's spotter may generate its QR.
    const isFinder = booking.user_id === requesterId;
    const isSpotter = booking.parking_spots && booking.parking_spots.spotter_id === requesterId;
    if (!isFinder && !isSpotter) throw new Error('Not authorized for this booking');

    const { arrears, total } = PaymentService.computePayable(booking, booking.users);
    const amountPaise = Math.round(total * 100);
    if (!(amountPaise > 0)) throw new Error('Invalid booking amount');

    const closeBy = Math.floor(Date.now() / 1000) + 30 * 60; // 30-minute validity
    const qr = await razorpayAdapter.createQrCode({
      amountPaise, bookingId, description: `ParkStop booking #${bookingId}`, closeBy,
      notes: { arrears: String(arrears) }
    });
    return { qrId: qr.id, imageUrl: qr.image_url, amount: amountPaise / 100 };
  }

  /**
   * ✅ QR SETTLEMENT (server-to-server, authoritative)
   * Handles `qr_code.credited`. booking_id comes from the QR's notes (set by us
   * at creation); the payment must be captured and at least cover the base
   * price. Idempotent via the shared atomic claim.
   */
  static async settleFromQrCredit(paymentEntity, qrEntity) {
    if (!paymentEntity || paymentEntity.status !== 'captured') {
      return { handled: false, reason: 'not captured' };
    }
    const bookingId = qrEntity?.notes?.booking_id;
    if (!bookingId) {
      logger.warn(`QR credit ${paymentEntity.id} has no booking_id note — skipping`);
      return { handled: false, reason: 'no booking' };
    }
    const booking = await prisma.bookings.findUnique({ where: { id: parseInt(bookingId) } });
    if (!booking) throw new Error(`Booking ${bookingId} not found for QR credit`);

    const minPaise = Math.round(PaymentService.computePayable(booking, null).base * 100);
    if (Number(paymentEntity.amount) < minPaise) {
      logger.error(`QR UNDERPAID booking ${bookingId}: got ${paymentEntity.amount} < base ${minPaise}`);
      throw new Error('QR amount underpaid');
    }

    const updated = await PaymentService._finalizeClaimedBooking(bookingId, paymentEntity.id, Number(qrEntity?.notes?.arrears || 0));
    if (!updated) {
      logger.info(`QR: booking ${bookingId} already settled — idempotent ack`);
      return { handled: true, alreadySettled: true };
    }
    logger.info(`QR settled booking ${bookingId} via payment ${paymentEntity.id}`);
    return { handled: true };
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

    const booking = await prisma.bookings.findUnique({ where: { id: parseInt(bookingId) } });
    if (!booking) throw new Error(`Booking ${bookingId} not found for webhook`);
    if (String(order?.notes?.user_id) !== String(booking.user_id)) {
      logger.error(`Webhook USER MISMATCH for booking ${bookingId}: order user ${order?.notes?.user_id} vs booking user ${booking.user_id}`);
      throw new Error('Webhook user mismatch');
    }

    const updatedBooking = await PaymentService._finalizeClaimedBooking(
      bookingId, paymentEntity.id, Number(order?.notes?.arrears || 0)
    );
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
  static async verifyRazorpayPayment(orderId, paymentId, signature, bookingId, userId = null) {
    try {
      const booking = await prisma.bookings.findUnique({
        where: { id: parseInt(bookingId) },
        include: { users: true }
      });
      if (!booking) throw new Error('Booking not found');
      if (userId != null && booking.user_id !== userId) {
        throw new Error('This booking does not belong to you.');
      }

      if (booking.payment_status === 'paid') {
        logger.info(`Payment verification for booking ${bookingId} was already processed (already paid)`);
        return { success: true, paymentId: booking.payment_id };
      }

      // 1. Signature: proves Razorpay issued this payment for this order.
      //    There is no test/mock shortcut — every booking needs a real payment.
      if (!orderId || !paymentId || !razorpayAdapter.verifyPaymentSignature(orderId, paymentId, signature)) {
        throw new Error('Payment signature verification failed.');
      }

      // 2. The order must have been created for THIS booking and THIS finder.
      //    Without this, one payment could be replayed to mark other bookings paid.
      const order = await razorpayAdapter.fetchOrder(orderId);
      if (!order || String(order.notes?.booking_id) !== String(booking.id) ||
          String(order.notes?.user_id) !== String(booking.user_id)) {
        logger.error(`Payment ${paymentId} / order ${orderId} does not belong to booking ${bookingId}`);
        throw new Error('This payment was not made for this booking.');
      }

      // 3. The payment must belong to that order, and be captured in full.
      let payment = await razorpayAdapter.fetchPayment(paymentId);
      if (!payment || payment.order_id !== orderId) {
        throw new Error('This payment was not made for this booking.');
      }
      if (payment.status === 'authorized') {
        // Account not set to auto-capture: capture it now so money isn't auto-refunded.
        payment = await razorpayAdapter.capturePayment(paymentId, Number(order.amount));
      }
      if (payment.status !== 'captured') {
        throw new Error(`Payment not completed (status: ${payment.status}).`);
      }
      if (Number(payment.amount) !== Number(order.amount)) {
        throw new Error(`Amount mismatch: order ${order.amount} paise, paid ${payment.amount} paise`);
      }

      // 4. The order must still cover the booking (price may have changed since).
      const minPaise = Math.round(PaymentService.computePayable(booking, null).base * 100);
      if (Number(order.amount) < minPaise) {
        throw new Error('The booking amount changed. Please pay again.');
      }

      // 5. A payment can settle only one booking.
      const reused = await prisma.bookings.findFirst({
        where: { payment_id: paymentId, id: { not: booking.id } },
        select: { id: true }
      });
      if (reused) throw new Error('This payment was already used for another booking.');

      // 6. Atomic claim — exactly one caller (client verify or webhook) wins.
      const updatedBooking = await PaymentService._finalizeClaimedBooking(
        bookingId, paymentId, Number(order.notes?.arrears || 0)
      );
      if (!updatedBooking) {
        logger.info(`Booking ${bookingId} was settled concurrently — idempotent return`);
      }
      return { success: true, paymentId };
    } catch (error) {
      logger.error('Razorpay Verification Error:', error);
      throw error;
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

      // Razorpay is the only gateway.
      const refundId = await razorpayAdapter.refund(booking.payment_id, amount);

      await PaymentService.markPaymentRefunded(booking, amount);

      // The refund id itself: BookingRefundService stores it on the booking.
      return refundId;
    } catch (error) {
      logger.error('Refund Error:', error);
      throw error;
    }
  }

  /**
   * Record on the booking which kind of refund its payment has had.
   *
   * The cancellation ladder hands back 70% or 50%, never the lot, so writing
   * 'refunded' for every one of them meant a booking that returned 280 of 400
   * read in every report as fully refunded -- and the 120 the owner and the
   * platform actually kept was invisible. An amount of undefined means
   * Razorpay refunds the whole payment.
   *
   * Shared by processRefund and by the retry path, which can find that an
   * earlier attempt already went through and must record it the same way.
   */
  static async markPaymentRefunded(booking, amount) {
    const collected = Number(booking.amount_paid || 0);
    const returned = amount === undefined || amount === null ? collected : Number(amount);
    const fully = !(collected > 0) || returned >= collected;

    await prisma.bookings.update({
      where: { id: parseInt(booking.id) },
      data: {
        payment_status: fully ? 'refunded' : 'partially_refunded',
        updated_at: new Date()
      }
    });
  }

  /**
   * What Razorpay says has already been refunded on this payment.
   *
   * amount_refunded is in paise and rises as soon as a refund is created, not
   * only once it settles, so a refund that timed out on our side but was
   * accepted on theirs shows up here.
   *
   * @returns {Promise<{refundedPaise: number, refundId: string|null}>}
   */
  static async fetchRefundState(paymentId) {
    const payment = await razorpayAdapter.fetchPayment(paymentId);
    const refundedPaise = Number(payment?.amount_refunded || 0);

    let refundId = null;
    if (refundedPaise > 0) {
      // Best effort: the id is for the record, not for the decision.
      try {
        const refunds = await razorpayAdapter.fetchRefunds(paymentId);
        refundId = refunds[0]?.id || null;
      } catch (err) {
        logger.warn(`Could not list refunds for payment ${paymentId}: ${err?.message}`);
      }
    }

    return { refundedPaise, refundId };
  }
}

module.exports = PaymentService;
