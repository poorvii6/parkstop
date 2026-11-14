const prisma = require('../config/prisma');
const logger = require('../utils/logger');
const { VISIBLE_SPOT_STATUSES } = require('../constants/spotVerification');

class SavedSpotController {
  /**
   * GET ALL SAVED SPOTS (Finder only)
   */
  static async getSavedSpots(req, res) {
    try {
      const userId = req.user.id;

      // This list had NO filter at all — not the spot's verification, not the
      // owner's, not even is_active. So it returned deleted spots, switched-off
      // spots and spots the finder hides, each as a bookable card. A saved spot
      // is a shortcut into the booking flow, so it has to answer the same
      // question the finder does.
      //
      // Hidden rather than shown as unavailable: the finder treats an
      // unverified spot as not existing, and two screens giving a driver
      // different answers about the same spot is worse than one of them being
      // briefly empty. The saved_spots row stays, so the card comes back by
      // itself if the spot is approved later.
      const savedSpots = await prisma.saved_spots.findMany({
        where: {
          user_id: userId,
          parking_spots: {
            is_active: true,
            deleted_at: null,
            spot_verification_status: { in: VISIBLE_SPOT_STATUSES },
            users: { verification_status: 'approved' },
          },
        },
        include: {
          parking_spots: true
        }
      });
      
      // Map to return the parking spots data directly as expected by the frontend
      const spots = savedSpots.map(s => {
        const spot = s.parking_spots;
        return {
          id: spot.id,
          spotter_id: spot.spotter_id,
          title: spot.title,
          description: spot.description,
          price_per_hour: spot.price_per_hour ? Number(spot.price_per_hour) : 0,
          latitude: spot.latitude ? Number(spot.latitude) : 0,
          longitude: spot.longitude ? Number(spot.longitude) : 0,
          is_available: spot.is_available,
          address: spot.address,
          total_slots: spot.total_slots,
          available_slots: spot.available_slots,
          location_type: spot.location_type,
          amenities: spot.amenities,
          images: spot.images,
          // Extra alias to match s.price_per_hour from client
          price_per_hour_decimal: spot.price_per_hour
        };
      });
      
      res.json({
        success: true,
        data: spots
      });
    } catch (error) {
      logger.error('Get saved spots error:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching saved spots',
        error: error.message
      });
    }
  }

  /**
   * TOGGLE SAVED SPOT (Finder only)
   */
  static async toggleSavedSpot(req, res) {
    try {
      const userId = req.user.id;
      const spotId = parseInt(req.params.spotId || req.params.id);

      if (isNaN(spotId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid spot ID'
        });
      }

      // Check if spot exists
      const spot = await prisma.parking_spots.findUnique({
        where: { id: spotId }
      });

      if (!spot) {
        return res.status(404).json({
          success: false,
          message: 'Parking spot not found'
        });
      }

      // Check if already saved
      const existing = await prisma.saved_spots.findFirst({
        where: {
          user_id: userId,
          spot_id: spotId
        }
      });

      if (existing) {
        // Unsave it
        await prisma.saved_spots.delete({
          where: {
            id: existing.id
          }
        });

        return res.json({
          success: true,
          message: 'Spot removed from saved spots',
          saved: false
        });
      } else {
        // Save it
        await prisma.saved_spots.create({
          data: {
            user_id: userId,
            spot_id: spotId
          }
        });

        return res.json({
          success: true,
          message: 'Spot added to saved spots',
          saved: true
        });
      }

    } catch (error) {
      logger.error('Toggle saved spot error:', error);
      res.status(500).json({
        success: false,
        message: 'Error toggling saved spot',
        error: error.message
      });
    }
  }
}

module.exports = SavedSpotController;
