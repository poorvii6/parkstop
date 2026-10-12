const express = require('express');
const { body } = require('express-validator');
const PaymentController = require('../controllers/paymentController');
const { authenticate, authorize } = require('../middleware/auth');
const validate = require('../middleware/validator');

const router = express.Router();

// Razorpay webhook — NO auth middleware: it is authenticated by HMAC signature
// (see PaymentController.razorpayWebhook). Must be registered before the
// authenticated routes so nothing intercepts it.
router.post('/webhook', PaymentController.razorpayWebhook);

// Booking payment QR — credits ParkStop (not the spotter's personal UPI).
router.post('/booking-qr', authenticate, authorize('FINDER', 'SPOTTER'), PaymentController.createBookingQr);

/**
 * 💳 MANAGE PAYMENT METHODS
 */

router.get(
  '/methods',
  authenticate,
  authorize('FINDER', 'SPOTTER'),
  PaymentController.getPaymentMethods
);

router.get(
  '/history',
  authenticate,
  authorize('FINDER', 'SPOTTER'),
  PaymentController.getPaymentHistory
);

router.post(
  '/withdraw',
  authenticate,
  authorize('FINDER', 'SPOTTER'),
  PaymentController.withdrawEarnings
);

// /refund removed: refunds happen only through BookingRefundService when a
// booking is cancelled. The old route let any finder refund any booking.

/**
 * 💳 RAZORPAY PAYMENT FLOW
 */
router.post(
  '/razorpay/create-order',
  authenticate,
  authorize('FINDER'),
  [
    body('bookingId').isInt().withMessage('Valid Booking ID is required'),
    validate
  ],
  PaymentController.createRazorpayOrder
);

router.post(
  '/razorpay/verify',
  authenticate,
  authorize('FINDER'),
  [
    body('bookingId').isInt().withMessage('Valid Booking ID is required'),
    body('razorpay_order_id').notEmpty().withMessage('Razorpay order ID is required'),
    body('razorpay_payment_id').notEmpty().withMessage('Razorpay payment ID is required'),
    body('razorpay_signature').notEmpty().withMessage('Razorpay signature is required'),
    validate
  ],
  PaymentController.verifyRazorpayPayment
);

module.exports = router;

