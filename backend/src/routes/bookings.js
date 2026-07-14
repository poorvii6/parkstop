const express = require('express');
const { body, param } = require('express-validator');
const rateLimit = require('express-rate-limit');

const BookingController = require('../controllers/bookingController');
const { authenticate, authorize } = require('../middleware/auth');
const validate = require('../middleware/validator');

const router = express.Router();

/**
 * 🔒 OTP Rate Limiter
 */
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: {
    success: false,
    message: 'Too many OTP attempts. Try again later.'
  }
});

/**
 * ✅ CREATE BOOKING (Finder only)
 */
router.post(
  '/',
  authenticate,
  authorize('FINDER'),
  [
    body('spot_id').isInt().withMessage('Spot ID must be an integer'),
    body('start_time').isISO8601().withMessage('Invalid start time'),
    body('end_time').isISO8601().withMessage('Invalid end time'),
    validate
  ],
  BookingController.createBooking
);

/**
 * ✅ VERIFY OTP (Spotter only)
 */
router.post(
  '/verify-otp',
  otpLimiter,
  authenticate,
  authorize('SPOTTER'),
  [
    body('bookingId').isInt().withMessage('Booking ID must be an integer'),
    body('otp').isLength({ min: 4, max: 6 }).withMessage('Invalid OTP'),
    validate
  ],
  BookingController.verifyOTP
);

/**
 * ✅ VERIFY CHECKOUT OTP (Spotter only)
 */
router.post(
  '/verify-checkout-otp',
  otpLimiter,
  authenticate,
  authorize('SPOTTER'),
  [
    body('bookingId').isInt().withMessage('Booking ID must be an integer'),
    body('otp').isLength({ min: 4, max: 6 }).withMessage('Invalid Checkout OTP'),
    validate
  ],
  BookingController.verifyCheckoutOTP
);

/**
 * ✅ COMPLETE BOOKING (Spotter only)
 */
router.put(
  '/:id/complete',
  authenticate,
  authorize('SPOTTER'),
  [
    param('id').isInt().withMessage('Booking ID must be an integer'),
    validate
  ],
  BookingController.completeBooking
);

/**
 * ✅ CHECKOUT UNPAID / ARREARS (Spotter only)
 */
router.put(
  '/:id/checkout-unpaid',
  authenticate,
  authorize('SPOTTER'),
  [
    param('id').isInt().withMessage('Booking ID must be an integer'),
    validate
  ],
  BookingController.checkoutUnpaid
);

/**
 * ✅ CHECKOUT CASH (Spotter only)
 */
router.put(
  '/:id/checkout-cash',
  authenticate,
  authorize('SPOTTER'),
  [
    param('id').isInt().withMessage('Booking ID must be an integer'),
    validate
  ],
  BookingController.checkoutCash
);

/**
 * ✅ GET CHECKOUT AMOUNT (Spotter or Finder)
 */
router.get(
  '/:id/checkout-amount',
  authenticate,
  [
    param('id').isInt().withMessage('Booking ID must be an integer'),
    validate
  ],
  BookingController.getCheckoutAmount
);

/**
 * ✅ FINDER CHECKOUT (Finder only)
 */
router.put(
  '/:id/finder-checkout',
  authenticate,
  authorize('FINDER'),
  [
    param('id').isInt().withMessage('Booking ID must be an integer'),
    validate
  ],
  BookingController.finderCheckout
);

/**
 * ✅ UPDATE PAYMENT MODE (Finder only)
 */
router.patch(
  '/:id/payment-mode',
  authenticate,
  authorize('FINDER'),
  [
    param('id').isInt().withMessage('Booking ID must be an integer'),
    body('payment_mode').isIn(['online', 'cash']).withMessage('Payment mode must be either online or cash'),
    validate
  ],
  BookingController.updatePaymentMode
);

/**
 * ✅ CANCEL BOOKING (Finder only)
 */
router.put(
  '/:id/cancel',
  authenticate,
  authorize('FINDER'),
  [
    param('id').isInt().withMessage('Booking ID must be an integer'),
    validate
  ],
  BookingController.cancelBooking
);

/**
 * ✅ EXTEND BOOKING (Finder only)
 */
router.put(
  '/:id/extend',
  authenticate,
  authorize('FINDER'),
  [
    param('id').isInt().withMessage('Booking ID must be an integer'),
    body('additionalHours').isNumeric().withMessage('Additional hours must be a number'),
    validate
  ],
  BookingController.extendBooking
);

/**
 * ✅ GET MY BOOKINGS (Finder)
 */
router.get(
  '/my-bookings',
  authenticate,
  authorize('FINDER'),
  BookingController.getUserBookings
);

/**
 * ✅ GET SPOTTER BOOKINGS
 */
router.get(
  '/spotter-bookings',
  authenticate,
  authorize('SPOTTER'),
  BookingController.getSpotterBookings
);

/**
 * ✅ CALCULATE UPFRONT PRICE (Finder only)
 */
router.post(
  '/calculate-price',
  authenticate,
  authorize('FINDER'),
  [
    body('spot_id').isInt().withMessage('Spot ID must be an integer'),
    body('start_time').isISO8601().withMessage('Invalid start time'),
    body('end_time').isISO8601().withMessage('Invalid end time'),
    validate
  ],
  BookingController.calculateUpfrontPrice
);

module.exports = router;
