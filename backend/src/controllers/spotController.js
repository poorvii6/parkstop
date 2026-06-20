const ParkingSpot = require('../models/ParkingSpot');
const PricingService = require('../services/PricingService');
const prisma = require('../config/prisma');
const logger = require('../utils/logger');

class SpotController {

  /**
   * GET SPOTTER DASHBOARD
   */
  static async getDashboardData(req, res) {
    try {
      if (!req.user.role || req.user.role.toLowerCase() !== 'spotter') {
        return res.status(403).json({
          success: false,
          message: 'Only spotters can view dashboard stats'
        });
      }
      
      const stats = await ParkingSpot.getSpotterDashboard(req.user.id);
      
      const user = await require('../config/prisma').users.findUnique({
        where: { id: req.user.id },
        select: { balance: true }
      });

      res.json({
        success: true,
        data: {
          ...stats,
          balance: user?.balance || 0
        }
      });
    } catch (error) {
      logger.error('Dashboard Stats Error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve dashboard stats'
      });
    }
  }

  /**
   * CREATE SPOT (SPOTTER ONLY)
   */
  static async createSpot(req, res) {
    try {
      if (req.user.role.toLowerCase() !== 'spotter') {
        return res.status(403).json({
          success: false,
          message: 'Only spotters can create spots'
        });
      }

      const {
        title,
        description,
        price_per_hour,
        latitude,
        longitude,
        address,
        location_type = 'urban',
        total_slots = 1,
        car_slots = 1,
        bike_slots = 0,
        images = [],
        amenities = []
      } = req.body;

      if (!price_per_hour || price_per_hour <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Valid price_per_hour is required'
        });
      }

      const spot = await ParkingSpot.create({
        title,
        description,
        price_per_hour: Number(price_per_hour),
        latitude,
        longitude,
        address,
        location_type,
        total_slots,
        car_slots,
        bike_slots,
        images,
        amenities,
        spotter_id: req.user.id
      });

      res.status(201).json({
        success: true,
        message: 'Parking spot created successfully',
        data: spot
      });

    } catch (error) {
      logger.error('Create spot error:', error);
      res.status(500).json({
        success: false,
        message: 'Error creating spot',
        error: error.message
      });
    }
  }

  /**
   * GET NEARBY SPOTS
   */
  static async getNearbySpots(req, res) {
    try {
      const { lat, lng, radius = 5 } = req.query;

      if (!lat || !lng) {
        return res.status(400).json({
          success: false,
          message: 'Latitude and Longitude required'
        });
      }

      const spots = await ParkingSpot.findNearby(
        Number(lat),
        Number(lng),
        Number(radius)
      );

      let returnSpots = spots;
      let message = 'Spots retrieved successfully';

      if (spots.length === 0) {
        returnSpots = await ParkingSpot.findAbsoluteNearest(Number(lat), Number(lng), 5);
        message = 'No spots available exactly nearby. Showing the nearest alternatives.';
      }

      // 🔥 ENRICH WITH REAL-TIME PRICING & SURGE DATA
      const enrichedSpots = await Promise.all(returnSpots.map(async (spot) => {
        try {
          const pricing = await PricingService.calculatePrice({
            basePrice: Number(spot.price_per_hour),
            locationType: spot.location_type,
            spotId: spot.id
          });
          return {
            ...spot,
            dynamic_price: pricing.finalPrice,
            surge_multiplier: pricing.multiplier,
            pricing_breakdown: pricing.breakdown
          };
        } catch (e) {
          return { ...spot, dynamic_price: spot.price_per_hour, surge_multiplier: 1.0 };
        }
      }));

      res.json({
        success: true,
        count: enrichedSpots.length,
        message: message,
        data: enrichedSpots
      });

    } catch (error) {
      logger.error('Nearby spots error:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching nearby spots'
      });
    }
  }

  /**
   * GET AVAILABLE SPOTS
   */
  static async getAvailableSpots(req, res) {
    try {
      const spots = await ParkingSpot.findAvailable();

      res.json({
        success: true,
        data: spots
      });

    } catch (error) {
      logger.error('Get spots error:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching spots'
      });
    }
  }

  /**
   * UPDATE SPOT
   */
  static async updateSpot(req, res) {
    try {
      const spot = await ParkingSpot.findById(req.params.id);

      if (!spot || spot.spotter_id !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: 'Unauthorized'
        });
      }

      const updated = await ParkingSpot.update(req.params.id, req.user.id, req.body);

      res.json({
        success: true,
        message: 'Spot updated',
        data: updated
      });

    } catch (error) {
      logger.error('Update spot error:', error);
      res.status(500).json({
        success: false,
        message: 'Error updating spot'
      });
    }
  }

  /**
   * DELETE SPOT
   */
  static async deleteSpot(req, res) {
    try {
      const spot = await ParkingSpot.findById(req.params.id);

      if (!spot || spot.spotter_id !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: 'Unauthorized'
        });
      }

      await ParkingSpot.delete(req.params.id, req.user.id);

      res.json({
        success: true,
        message: 'Spot deleted successfully'
      });

    } catch (error) {
      logger.error('Delete spot error:', error);
      res.status(500).json({
        success: false,
        message: 'Error deleting spot'
      });
    }
  }

  /**
   * GET SLOT STATUS FOR A SPOT
   * Returns individual slot availability (e.g. A1, A2, B1)
   */
  static async getSlotStatus(req, res) {
    try {
      const spotId = parseInt(req.params.id);
      const spot = await ParkingSpot.findById(spotId);
      if (!spot) {
        return res.status(404).json({ success: false, message: 'Spot not found' });
      }

      const slotNames = spot.slot_names || [];

      // If no named slots configured, generate defaults based on total_slots
      const finalSlotNames = slotNames.length > 0
        ? slotNames
        : Array.from({ length: spot.total_slots || 1 }, (_, i) => `Slot ${String.fromCharCode(65 + Math.floor(i / 10))}${(i % 10) + 1}`);

      // Get all active/reserved bookings for this spot
      const activeBookings = await prisma.bookings.findMany({
        where: {
          spot_id: spotId,
          status: { in: ['reserved', 'active'] }
        },
        select: { slot_name: true, status: true }
      });

      const bookedSlots = {};
      activeBookings.forEach(b => {
        if (b.slot_name) {
          bookedSlots[b.slot_name] = b.status === 'active' ? 'occupied' : 'booked';
        }
      });

      const slots = finalSlotNames.map(name => ({
        name,
        status: bookedSlots[name] || 'available'
      }));

      res.json({ success: true, data: slots });
    } catch (error) {
      logger.error('Get slot status error:', error);
      res.status(500).json({ success: false, message: 'Error fetching slot status' });
    }
  }
}

module.exports = SpotController;
