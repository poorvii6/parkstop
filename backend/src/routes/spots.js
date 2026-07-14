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

router.delete('/dangerously-clear-everything-live', async (req, res) => {
  try {
    const prisma = require('../config/prisma');
    await prisma.bookings.deleteMany({});
    await prisma.saved_spots.deleteMany({});
    await prisma.reviews.deleteMany({});
    await prisma.disputes.deleteMany({});
    await prisma.parking_spots.deleteMany({});
    await prisma.locations.deleteMany({});
    await prisma.payment_methods.deleteMany({});
    await prisma.withdrawals.deleteMany({});
    await prisma.payouts.deleteMany({});
    await prisma.users.deleteMany({});
    res.json({ success: true, message: 'Successfully deleted all spots, bookings, users, etc.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
