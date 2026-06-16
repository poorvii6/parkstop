const express = require('express');
const router = express.Router();

const { authenticate, authorize } = require('../middleware/auth');
const { getSpotterAnalytics, getPlatformAnalytics, getTopSpotters } = require('../controllers/analyticsController');

/**
 * 📊 Spotter Dashboard (ONLY spotter)
 */
router.get(
  '/spotter/:spotterId',
  authenticate,
  authorize('SPOTTER'),
  getSpotterAnalytics
);

/**
 * 📊 Platform Analytics (ADMIN only)
 */
router.get(
  '/platform',
  authenticate,
  authorize('ADMIN'),
  getPlatformAnalytics
);

/**
 * 📊 Top Spotters (ADMIN only)
 */
router.get(
  '/top-spotters',
  authenticate,
  authorize('ADMIN'),
  getTopSpotters
);

module.exports = router;
