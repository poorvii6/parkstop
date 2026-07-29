const Razorpay = require('razorpay');
const crypto = require('crypto');
const logger = require('../../utils/logger');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

class RazorpayAdapter {

  /**
   * CREATE ORDER
   * Razorpay requires an order to be created before payment.
   * The frontend uses this order ID to open the Razorpay checkout.
   */
  async createOrder(amount, receipt, metadata) {
    try {
      const options = {
        amount: Math.round(Number(amount) * 100), // Amount in paise (₹1 = 100 paise)
        currency: 'INR',
        receipt: receipt.toString(),
        notes: metadata || {}
      };
      const order = await razorpay.orders.create(options);
      return {
        orderId: order.id,
        amount: order.amount,
        currency: order.currency
      };
    } catch (error) {
      logger.error('Razorpay Order Error:', error);
      throw error;
    }
  }

  /**
   * VERIFY PAYMENT SIGNATURE
   * After the user completes payment on the frontend, Razorpay sends back
   * razorpay_order_id, razorpay_payment_id, and razorpay_signature.
   * We verify the signature server-side to confirm the payment is genuine.
   */
  verifyPaymentSignature(orderId, paymentId, signature) {
    if (typeof signature !== 'string' || !signature) return false;

    const body = orderId + '|' + paymentId;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    // Constant-time comparison. `===` short-circuits at the first differing
    // character, so how long it takes leaks how much of the signature was
    // correct — an attacker can in principle recover a valid signature one
    // character at a time by timing responses. Remote timing attacks over a
    // network are hard in practice, but this is a payment authorisation check
    // and the constant-time version costs nothing.
    const expectedBuf = Buffer.from(expectedSignature, 'utf8');
    const providedBuf = Buffer.from(signature, 'utf8');

    // timingSafeEqual throws unless both buffers are the same length. Bailing
    // out here leaks only the length, which is fixed for a SHA-256 hex digest
    // and therefore public knowledge.
    if (expectedBuf.length !== providedBuf.length) return false;

    return crypto.timingSafeEqual(expectedBuf, providedBuf);
  }

  /**
   * CREATE DYNAMIC UPI QR (credits ParkStop, NOT the spotter)
   * A single-use, fixed-amount UPI QR the finder scans in GPay/PhonePe/Paytm.
   * The money lands in ParkStop's Razorpay account; `qr_code.credited` webhook
   * then settles the booking. booking_id travels in notes so the webhook can
   * recover it. Raw REST (Basic auth) to stay independent of SDK versions.
   */
  async createQrCode({ amountPaise, bookingId, description, closeBy }) {
    const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
    const body = {
      type: 'upi_qr',
      name: `ParkStop #${bookingId}`,
      usage: 'single_use',
      fixed_amount: true,
      payment_amount: amountPaise,
      description: description || `ParkStop booking ${bookingId}`,
      notes: { booking_id: String(bookingId) },
    };
    if (closeBy) body.close_by = closeBy;
    const res = await fetch('https://api.razorpay.com/v1/payments/qr_codes', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      logger.error('Razorpay QR create error:', data);
      throw new Error(data.error?.description || 'Failed to create payment QR');
    }
    return data; // { id, image_url, ... }
  }

  /**
   * VERIFY WEBHOOK SIGNATURE
   * Razorpay signs webhook deliveries with HMAC-SHA256 of the RAW request body
   * using the webhook secret (a separate secret from the API key). Timing-safe
   * comparison for the same reason as verifyPaymentSignature above.
   */
  verifyWebhookSignature(rawBody, signature) {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret || !rawBody || typeof signature !== 'string' || !signature) return false;

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    const expectedBuf = Buffer.from(expectedSignature, 'utf8');
    const providedBuf = Buffer.from(signature, 'utf8');
    if (expectedBuf.length !== providedBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, providedBuf);
  }

  /**
   * FETCH ORDER
   * Used by the webhook to recover our metadata (booking_id/user_id notes)
   * from the order the captured payment belongs to.
   */
  async fetchOrder(orderId) {
    try {
      return await razorpay.orders.fetch(orderId);
    } catch (error) {
      logger.error('Razorpay Fetch Order Error:', error);
      throw error;
    }
  }

  /**
   * FETCH PAYMENT DETAILS
   * Retrieve full payment details from Razorpay after verification.
   */
  async fetchPayment(paymentId) {
    try {
      const payment = await razorpay.payments.fetch(paymentId);
      return payment;
    } catch (error) {
      logger.error('Razorpay Fetch Payment Error:', error);
      throw error;
    }
  }

  /**
   * CREATE TRANSFER (Route system for splitting revenue)
   * Sends the spotter's share to their linked Razorpay account.
   */
  async splitAndTransfer(paymentId, spotterAmount, spotterAccountId) {
    try {
      const transfer = await razorpay.payments.transfer(paymentId, {
        transfers: [
          {
            account: spotterAccountId,
            amount: Math.round(Number(spotterAmount) * 100),
            currency: 'INR',
            notes: {
              info: 'Parking spotter payout'
            }
          }
        ]
      });
      return transfer;
    } catch (error) {
      logger.error('Razorpay Transfer Error:', error);
      throw error;
    }
  }

  /**
   * REFUND
   * Full or partial refund for a completed payment.
   */
  async refund(paymentId, amount) {
    try {
      const options = {
        amount: amount ? Math.round(Number(amount) * 100) : undefined
      };
      const refund = await razorpay.payments.refund(paymentId, options);
      return refund.id;
    } catch (error) {
      logger.error('Razorpay Refund Error:', error);
      throw error;
    }
  }
}

module.exports = new RazorpayAdapter();
module.exports.razorpayInstance = razorpay;
