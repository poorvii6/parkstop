const express = require('express');
const { body, query, param } = require('express-validator');

const SpotController = require('../controllers/spotController');
const { authenticate, authorize } = require('../middleware/auth');
const validate = require('../middleware/validator');

const router = express.Router();

/**
 * DASHBOARD STATS
 */
router.get(
  '/dashboard',
  authenticate,
  authorize('SPOTTER'),
  SpotController.getDashboardData
);

/**
 * CREATE PARKING SPOT (Spotter only)
 */
router.post(
  '/',
  authenticate,
  authorize('SPOTTER', 'ADMIN'),
  [
    body('title')
      .notEmpty()
      .withMessage('Title is required'),

    body('description')
      .optional()
      .isString(),

    body('latitude')
      .isFloat({ min: -90, max: 90 })
      .withMessage('Latitude must be between -90 and 90'),

    body('longitude')
      .isFloat({ min: -180, max: 180 })
      .withMessage('Longitude must be between -180 and 180'),

    body('price_per_hour')
      .optional()
      .isFloat({ min: 1, max: 10000 })
      .withMessage('Price must be between ₹1 and ₹10,000 per hour'),

    body('total_slots')
      .optional()
      .isInt({ min: 1, max: 50 })
      .withMessage('Total slots must be between 1 and 50'),

    validate
  ],
  SpotController.createSpot
);

/**
 * FIND NEARBY PARKING SPOTS
 * Used by mobile apps
 */
router.get(
  '/nearby',
  [
    query('lat')
      .exists()
      .isFloat()
      .withMessage('Latitude is required'),

    query('lng')
      .exists()
      .isFloat()
      .withMessage('Longitude is required'),

    query('radius')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Radius must be positive'),

    validate
  ],
  SpotController.getNearbySpots
);

/**
 * GET ALL AVAILABLE SPOTS
 */
router.get(
  '/',
  SpotController.getAvailableSpots
);

/**
 * GET SLOT STATUS FOR A SPOT
 */
router.get(
  '/:id/slots',
  [
    param('id').isInt().withMessage('Spot ID must be integer'),
    validate
  ],
  SpotController.getSlotStatus
);

/**
 * UPDATE SPOT
 */
router.put(
  '/:id',
  authenticate,
  authorize('SPOTTER', 'ADMIN'),
  [
    param('id')
      .isInt()
      .withMessage('Spot ID must be integer'),

    validate
  ],
  SpotController.updateSpot
);

/**
 * DELETE SPOT
 */
router.delete(
  '/:id',
  authenticate,
  authorize('SPOTTER', 'ADMIN'),
  [
    param('id')
      .isInt()
      .withMessage('Spot ID must be integer'),

    validate
  ],
  SpotController.deleteSpot
);

module.exports = router;
