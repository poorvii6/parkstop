const Stripe = require('stripe');
const logger = require('../../utils/logger');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

class StripeAdapter {
  
  /**
   * CREATE CUSTOMER
   */
  async createCustomer(email, name) {
    const customer = await stripe.customers.create({ email, name });
    return customer.id;
  }

  /**
   * CREATE PAYMENT INTENT (Manual Checkout)
   */
  async createPaymentIntent(amount, metadata) {
    const amountInCents = Math.round(Number(amount) * 100);
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: 'usd',
      metadata
    });
    return {
      transactionId: paymentIntent.id,
      client_secret: paymentIntent.client_secret
    };
  }

  /**
   * ATTACH PAYMENT METHOD (Tokenization)
   */
  async attachPaymentMethod(customerId, paymentMethodId) {
    await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });
    return true;
  }

  /**
   * CHARGE (Automatic / Seamless)
   */
  async charge(amount, customerId, paymentMethodId, metadata) {
    try {
      const amountInCents = Math.round(Number(amount) * 100);
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amountInCents,
        currency: 'usd',
        customer: customerId,
        payment_method: paymentMethodId,
        off_session: true,
        confirm: true,
        metadata
      });
      return {
        success: true,
        transactionId: paymentIntent.id,
        status: paymentIntent.status
      };
    } catch (error) {
      logger.error('Stripe Charge Error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * PAYOUT TO SPOTTER
   */
  async payout(amount, destinationAccountId, metadata) {
    const amountInCents = Math.round(Number(amount) * 100);
    const transfer = await stripe.transfers.create({
      amount: amountInCents,
      currency: 'usd',
      destination: destinationAccountId,
      metadata
    });
    return transfer.id;
  }

  /**
   * REFUND (Customer Protection)
   */
  async refund(paymentIntentId, amount) {
    const amountInCents = amount ? Math.round(Number(amount) * 100) : undefined;
    const refund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
      amount: amountInCents
    });
    return refund.id;
  }
}

module.exports = new StripeAdapter();
