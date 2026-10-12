/**
 * The money endpoints that were only ever attack surface are GONE, not just
 * patched: wallet top-up, clearing dues, Stripe, Cashfree payments, cash
 * checkout, "mark unpaid" and switching a booking to cash. ParkStop takes
 * payment one way only: Razorpay, verified on the server.
 *
 *   npx jest tests/security/paymentEndpoints.test.js
 */
jest.mock('../../src/config/prisma', () => ({}));
jest.mock('../../src/services/payments/RazorpayAdapter', () => ({}));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const PaymentController = require('../../src/controllers/paymentController');
const BookingController = require('../../src/controllers/bookingController');
const paymentRoutes = require('../../src/routes/payments');
const bookingRoutes = require('../../src/routes/bookings');

const paths = (router) =>
  router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);

test('removed payment handlers no longer exist', () => {
  for (const name of [
    'confirmWalletTopUp', 'topUpWallet', 'createClearDuesOrder', 'verifyClearDuesPayment',
    'verifyStripePayment', 'createCheckoutSession',
  ]) {
    expect(PaymentController[name]).toBeUndefined();
  }
  for (const name of ['checkoutCash', 'checkoutUnpaid', 'updatePaymentMode']) {
    expect(BookingController[name]).toBeUndefined();
  }
});

test('removed payment routes are not mounted', () => {
  const p = paths(paymentRoutes).join('\n');
  for (const gone of ['/wallet/', '/create-dues-order', '/verify-dues', '/stripe/', '/cashfree/', 'post /checkout']) {
    expect(p).not.toContain(gone);
  }
  expect(p).toContain('post /razorpay/create-order');
  expect(p).toContain('post /razorpay/verify');
  expect(p).toContain('post /webhook');
});

test('removed booking routes are not mounted', () => {
  const b = paths(bookingRoutes).join('\n');
  for (const gone of ['checkout-cash', 'checkout-unpaid', 'payment-mode']) {
    expect(b).not.toContain(gone);
  }
});
