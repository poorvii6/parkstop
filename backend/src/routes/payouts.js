const express = require('express');
const PayoutController = require('../controllers/payoutController');
const PayoutRequests = require('../controllers/payoutRequestController');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// Owner: where earnings will be paid (masked) and the wallet balance.
router.get('/account-status', authenticate, authorize('SPOTTER'), PayoutController.getAccountStatus);

// Owner: per-booking earnings credited to the wallet.
router.get('/history', authenticate, authorize('FINDER', 'SPOTTER'), PayoutController.getPayoutHistory);

// Owner: their payout history and when the next run is.
//
// There is no POST /request any more. Owners used to ask to be paid, which
// moved their whole balance out of the wallet on the spot and then waited on
// an admin -- with no admin, no owner-side cancel and nothing sweeping
// payout_requests, that money was simply stuck. Payouts now run every
// Saturday for everyone at once (services/weeklyPayoutService.js).
router.get('/requests', authenticate, authorize('SPOTTER'), PayoutRequests.myRequests);

// Admin: send the transfer by hand, then mark it paid (or reject it).
router.get('/admin/requests', authenticate, authorize('ADMIN'), PayoutRequests.adminList);
router.post('/admin/requests/:id/paid', authenticate, authorize('ADMIN'), PayoutRequests.adminMarkPaid);
router.post('/admin/requests/:id/reject', authenticate, authorize('ADMIN'), PayoutRequests.adminReject);

module.exports = router;
