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
    const body = orderId + '|' + paymentId;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    return expectedSignature === signature;
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
