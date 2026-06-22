const express = require('express');
const { body } = require('express-validator');
const DisputeController = require('../controllers/disputeController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validator');
const router = express.Router();

router.post('/',
  authenticate,
  [
    body('booking_id').isInt(),
    body('reason').isString().notEmpty().isLength({ max: 100 }),
    body('description').optional().isString().isLength({ max: 500 }),
    validate
  ],
  DisputeController.createDispute
);

module.exports = router;
