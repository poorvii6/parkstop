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
      const targetUserId = parseInt(req.params.userId);
      const currentUserId = req.user.id;

      if (currentUserId !== targetUserId) {
        const prisma = require('../config/prisma');
        // Check if there is a mutual active booking
        const activeBooking = await prisma.bookings.findFirst({
          where: {
            status: 'active',
            OR: [
              {
                user_id: currentUserId,
                parking_spots: {
                  spotter_id: targetUserId
                }
              },
              {
                user_id: targetUserId,
                parking_spots: {
                  spotter_id: currentUserId
                }
              }
            ]
          }
        });

        if (!activeBooking) {
          return res.status(403).json({ success: false, message: 'Unauthorized to view this user\'s location' });
        }
      }

      const location = await Location.findByUser(targetUserId);

      res.json({ success: true, data: location });
    } catch (error) {
      logger.error('Get location error:', error);
      res.status(500).json({ success: false, message: 'Error fetching location' });
    }
  }
}

module.exports = LocationController;