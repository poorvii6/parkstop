const express = require('express');
const { param } = require('express-validator');

const SavedSpotController = require('../controllers/savedSpotController');
const { authenticate, authorize } = require('../middleware/auth');
const validate = require('../middleware/validator');

const router = express.Router();

/**
 * GET ALL SAVED SPOTS (Finder only)
 */
router.get(
  '/',
  authenticate,
  authorize('FINDER'),
  SavedSpotController.getSavedSpots
);

/**
 * TOGGLE SAVED SPOT (Finder only)
 */
router.post(
  '/:spotId/toggle',
  authenticate,
  authorize('FINDER'),
  [
    param('spotId').isInt().withMessage('Spot ID must be an integer'),
    validate
  ],
  SavedSpotController.toggleSavedSpot
);

module.exports = router;
