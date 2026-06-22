const express = require('express');
const { body, param } = require('express-validator');
const ReviewController = require('../controllers/reviewController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validator');
const router = express.Router();

router.post('/',
  authenticate,
  [
    body('booking_id').isInt(),
    body('rating').isInt({ min: 1, max: 5 }),
    body('comment').optional().isString().isLength({ max: 500 }),
    validate
  ],
  ReviewController.createReview
);

router.get('/spot/:spotId',
  [param('spotId').isInt(), validate],
  ReviewController.getSpotReviews
);

module.exports = router;
