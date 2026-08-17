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
 * EARNINGS BREAKDOWN (itemised earnings + fees)
 */
router.get(
  '/earnings-breakdown',
  authenticate,
  authorize('SPOTTER'),
  SpotController.getEarningsBreakdown
);

/**
 * TOGGLE ALL SPOTS STATUS (Spotter only)
 */
router.put(
  '/toggle-all',
  authenticate,
  authorize('SPOTTER'),
  [
    body('online').isBoolean().withMessage('online must be a boolean'),
    validate
  ],
  SpotController.toggleAllSpots
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

const upload = require('../middleware/upload');

/**
 * IMAGE UPLOAD ENDPOINT
 */
router.post(
  '/:id/images',
  authenticate,
  authorize('SPOTTER', 'ADMIN'),
  upload.array('images', 5), // max 5 images
  async (req, res) => {
    try {
      const spotId = req.params.id;
      const prisma = require('../config/prisma');

      // OWNERSHIP. Without this, "are you a spotter?" was the only question
      // asked — so ANY spotter could attach images to ANY spot, including a
      // competitor's listing. updateSpot and deleteSpot both check this; the
      // check was simply never applied here, because this handler lives inline
      // in the routes file instead of in the controller with its siblings.
      const owned = await prisma.parking_spots.findUnique({
        where: { id: parseInt(spotId) },
        select: { spotter_id: true }
      });
      if (!owned) {
        return res.status(404).json({ success: false, message: 'Spot not found' });
      }
      // Admins may still manage any spot, matching the authorize() list above.
      const isAdmin = (req.user.role || '').toUpperCase() === 'ADMIN';
      if (!isAdmin && owned.spotter_id !== req.user.id) {
        return res.status(403).json({ success: false, message: 'You can only add images to your own spot' });
      }

      // No files attached would throw on .map below and surface as a 500.
      if (!Array.isArray(req.files) || req.files.length === 0) {
        return res.status(400).json({ success: false, message: 'No images were uploaded' });
      }

      const existingSpot = await prisma.parking_spots.findUnique({
        where: { id: parseInt(spotId) },
        select: { images: true }
      });
      const existingImages = Array.isArray(existingSpot?.images) ? existingSpot.images : [];
      const imageUrls = [...existingImages, ...req.files.map(f => f.path)];

      const spot = await prisma.parking_spots.update({
        where: { id: parseInt(spotId) },
        data: { images: imageUrls }
      });

      res.json({ success: true, data: { images: spot.images } });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Image upload failed' });
    }
  }
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
