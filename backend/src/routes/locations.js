const express = require('express');
const { body, param } = require('express-validator');
const LocationController = require('../controllers/locationController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validator');

const router = express.Router();

// Update current user location
router.post('/update', authenticate, [
  body('latitude').isFloat(),
  body('longitude').isFloat(),
  validate
], LocationController.updateLocation);

// Get user's last known location
router.get('/:userId', authenticate, [
  param('userId').isInt(),
  validate
], LocationController.getLocation);

module.exports = router;
