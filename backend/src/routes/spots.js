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
    // One chain per field. title and description each had two separate chains
    // here — a `notEmpty()` and a `isLength()` added later — which is how a
    // field ends up validated twice and read as validated once.
    body('title')
      .isString().withMessage('Title is required')
      .trim()
      .isLength({ min: 1, max: 120 }).withMessage('Title must be 1 to 120 characters'),

    body('description')
      .optional()
      .isString().withMessage('Description must be text')
      .isLength({ max: 2000 }).withMessage('Description must be 2000 characters or fewer'),

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

    // Create validated title, coordinates, price and total_slots but not the
    // per-type counters, the address or the lists — the same fields the update
    // route left open. Brought to the same shape so the two doors agree.
    //
    // The model re-checks capacity, price and coordinates and remains the
    // authority; these reject junk at the door and name the field that was
    // wrong, as the auth routes do.
    body('car_slots')
      .optional()
      .isInt({ min: 0, max: 50 })
      .withMessage('Car slots must be between 0 and 50'),

    body('bike_slots')
      .optional()
      .isInt({ min: 0, max: 50 })
      .withMessage('Bike slots must be between 0 and 50'),

    body('address')
      .optional()
      .isString().withMessage('Address must be text')
      .trim()
      .isLength({ min: 1, max: 300 }).withMessage('Address must be 1 to 300 characters'),

    body('location_type')
      .optional()
      .isString().withMessage('location_type must be text'),

    body('amenities')
      .optional()
      .isArray({ max: 30 }).withMessage('Amenities must be a list of up to 30 items'),
    body('amenities.*')
      .optional()
      .isString().withMessage('Each amenity must be text')
      .isLength({ max: 60 }).withMessage('Each amenity must be 60 characters or fewer'),

    body('images')
      .optional()
      .isArray({ max: 10 }).withMessage('Images must be a list of up to 10 items'),
    body('images.*')
      .optional()
      .isString().withMessage('Each image must be a URL string')
      .isLength({ max: 500 }).withMessage('Each image URL must be 500 characters or fewer'),

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

    // This route had NO body validators at all — only the id was checked — so
    // every field reached the model unexamined, which is how an owner came to
    // be able to set the commission rate and a negative price. Everything is
    // optional because an update is a partial, but anything PRESENT has to be
    // the right shape. The model validates the money and capacity fields again
    // and is the authority; these reject junk at the door, as the auth routes
    // do, and give a field-level message instead of one error for the body.
    //
    // `.optional()` here means ABSENT, not empty: express-validator v7 skips
    // undefined only, so `{"total_slots": null}` is validated and refused
    // rather than quietly read as "leave it alone". That is deliberate — null
    // is what a client sends when its own arithmetic produced NaN, and the app
    // computes total_slots as car_slots + bike_slots.
    body('title')
      .optional()
      .isString().withMessage('Title must be text')
      .trim()
      .isLength({ min: 1, max: 120 }).withMessage('Title must be 1 to 120 characters'),

    body('description')
      .optional()
      .isString().withMessage('Description must be text')
      .isLength({ max: 2000 }).withMessage('Description must be 2000 characters or fewer'),

    body('address')
      .optional()
      .isString().withMessage('Address must be text')
      .trim()
      .isLength({ min: 1, max: 300 }).withMessage('Address must be 1 to 300 characters'),

    body('price_per_hour')
      .optional()
      .isFloat({ min: 1, max: 10000 })
      .withMessage('Price must be between ₹1 and ₹10,000 per hour'),

    body('total_slots')
      .optional()
      .isInt({ min: 1, max: 50 })
      .withMessage('Total slots must be between 1 and 50'),

    body('car_slots')
      .optional()
      .isInt({ min: 0, max: 50 })
      .withMessage('Car slots must be between 0 and 50'),

    body('bike_slots')
      .optional()
      .isInt({ min: 0, max: 50 })
      .withMessage('Bike slots must be between 0 and 50'),

    body('latitude')
      .optional()
      .isFloat({ min: -90, max: 90 })
      .withMessage('Latitude must be between -90 and 90'),

    body('longitude')
      .optional()
      .isFloat({ min: -180, max: 180 })
      .withMessage('Longitude must be between -180 and 180'),

    // Half a coordinate is not a location. Sent alone, latitude used to be
    // dropped on the floor and answered with a 200, so the owner believed the
    // pin had moved while drivers kept navigating to the old place.
    body('longitude').custom((value, { req }) => {
      const given = (v) => v !== undefined && v !== null && v !== '';
      if (given(req.body?.latitude) !== given(value)) {
        throw new Error('latitude and longitude must be sent together');
      }
      return true;
    }),

    // Not an allowlist of values: location_type is admin-only and the model
    // discards it for anyone else, so this only refuses something that is not
    // even a string.
    body('location_type')
      .optional()
      .isString().withMessage('location_type must be text'),

    body('amenities')
      .optional()
      .isArray({ max: 30 }).withMessage('Amenities must be a list of up to 30 items'),
    body('amenities.*')
      .optional()
      .isString().withMessage('Each amenity must be text')
      .isLength({ max: 60 }).withMessage('Each amenity must be 60 characters or fewer'),

    body('images')
      .optional()
      .isArray({ max: 10 }).withMessage('Images must be a list of up to 10 items'),
    body('images.*')
      .optional()
      .isString().withMessage('Each image must be a URL string')
      .isLength({ max: 500 }).withMessage('Each image URL must be 500 characters or fewer'),

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
