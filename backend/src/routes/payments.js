const express = require('express');
const { body } = require('express-validator');
const PaymentController = require('../controllers/paymentController');
const { authenticate, authorize } = require('../middleware/auth');
const validate = require('../middleware/validator');

const router = express.Router();

/**
 * 💳 INITIATE CHECKOUT
 */
router.post(
  '/checkout',
  authenticate,
  authorize('FINDER'),
  [
    body('bookingId').isInt().withMessage('Valid Booking ID is required'),
    validate
  ],
  PaymentController.createCheckoutSession
);

/**
 * 💳 MANAGE PAYMENT METHODS
 */
router.post(
  '/methods',
  authenticate,
  authorize('FINDER', 'SPOTTER'),
  PaymentController.addPaymentMethod
);

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

router.put(
  '/methods/:id/default',
  authenticate,
  authorize('FINDER', 'SPOTTER'),
  PaymentController.setDefaultMethod
);

router.post(
  '/withdraw',
  authenticate,
  authorize('FINDER', 'SPOTTER'),
  PaymentController.withdrawEarnings
);

router.post(
  '/refund',
  authenticate,
  authorize('FINDER'),
  PaymentController.refundPayment
);

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

router.post(
  '/stripe/verify',
  authenticate,
  authorize('FINDER'),
  [
    body('bookingId').isInt().withMessage('Valid Booking ID is required'),
    body('paymentIntentId').notEmpty().withMessage('PaymentIntent ID is required'),
    validate
  ],
  PaymentController.verifyStripePayment
);

/**
 * 💳 CLEAR DUES (Spotter)
 */
router.post(
  '/create-dues-order',
  authenticate,
  authorize('SPOTTER'),
  PaymentController.createClearDuesOrder
);

router.post(
  '/verify-dues',
  authenticate,
  authorize('SPOTTER'),
  PaymentController.verifyClearDuesPayment
);

/**
 * 💳 WALLET TOP-UP (Finder)
 */
router.post(
  '/wallet/topup',
  authenticate,
  authorize('FINDER'),
  [
    body('amount').isFloat({ min: 50, max: 10000 }),
    validate
  ],
  PaymentController.topUpWallet
);

router.post(
  '/wallet/confirm',
  authenticate,
  authorize('FINDER'),
  [
    body('order_id').notEmpty(),
    body('payment_id').notEmpty(),
    body('signature').notEmpty(),
    body('amount').isFloat({ min: 50, max: 10000 }),
    validate
  ],
  PaymentController.confirmWalletTopUp
);

module.exports = router;

