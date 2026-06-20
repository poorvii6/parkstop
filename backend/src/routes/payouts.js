const express = require('express');
const { body } = require('express-validator');
const PayoutController = require('../controllers/payoutController');
const { authenticate, authorize } = require('../middleware/auth');
const validate = require('../middleware/validator');

const router = express.Router();

/**
 * 🏦 SETUP PAYOUT ACCOUNT
 * Spotter saves UPI ID or bank details → creates RazorpayX contact + fund account
 */
router.post(
  '/setup-account',
  authenticate,
  authorize('SPOTTER'),
  [
    body('type').isIn(['upi', 'bank']).withMessage('Type must be "upi" or "bank"'),
    validate
  ],
  PayoutController.setupPayoutAccount
);

/**
 * 📊 GET PAYOUT ACCOUNT STATUS
 */
router.get(
  '/account-status',
  authenticate,
  authorize('SPOTTER'),
  PayoutController.getAccountStatus
);

/**
 * 📜 GET PAYOUT HISTORY
 */
router.get(
  '/history',
  authenticate,
  authorize('FINDER', 'SPOTTER'),
  PayoutController.getPayoutHistory
);

/**
 * 🔄 UPDATE PAYOUT DETAILS
 */
router.put(
  '/update-details',
  authenticate,
  authorize('SPOTTER'),
  PayoutController.updatePayoutDetails
);

module.exports = router;
