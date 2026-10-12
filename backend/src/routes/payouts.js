const express = require('express');
const PayoutController = require('../controllers/payoutController');
const PayoutRequests = require('../controllers/payoutRequestController');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// Owner: where earnings will be paid (masked) and the wallet balance.
router.get('/account-status', authenticate, authorize('SPOTTER'), PayoutController.getAccountStatus);

// Owner: per-booking earnings credited to the wallet.
router.get('/history', authenticate, authorize('FINDER', 'SPOTTER'), PayoutController.getPayoutHistory);

// Owner: ask for the wallet balance to be sent to the verified bank account.
router.get('/requests', authenticate, authorize('SPOTTER'), PayoutRequests.myRequests);
router.post('/request', authenticate, authorize('SPOTTER'), PayoutRequests.requestPayout);

// Admin: send the transfer by hand, then mark it paid (or reject it).
router.get('/admin/requests', authenticate, authorize('ADMIN'), PayoutRequests.adminList);
router.post('/admin/requests/:id/paid', authenticate, authorize('ADMIN'), PayoutRequests.adminMarkPaid);
router.post('/admin/requests/:id/reject', authenticate, authorize('ADMIN'), PayoutRequests.adminReject);

module.exports = router;
