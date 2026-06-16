const Location = require('../models/Location');
const logger = require('../utils/logger');

class LocationController {
  // Update user GPS location
  static async updateLocation(req, res) {
    try {
      const { latitude, longitude } = req.body;

      const location = await Location.createOrUpdate({
        user_id: req.user.id,
        latitude,
        longitude
      });

      res.json({
        success: true,
        message: 'Location updated successfully',
        data: location
      });
    } catch (error) {
      logger.error('Update location error:', error);
      res.status(500).json({ success: false, message: 'Error updating location' });
    }
  }

  // Get last known location
  static async getLocation(req, res) {
    try {
      const location = await Location.findByUser(req.params.userId);

      res.json({ success: true, data: location });
    } catch (error) {
      logger.error('Get location error:', error);
      res.status(500).json({ success: false, message: 'Error fetching location' });
    }
  }
}

module.exports = LocationController;