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
   * GET EARNINGS BREAKDOWN (SPOTTER ONLY)
   *
   * Itemises where earnings and platform fees came from. Without this the
   * wallet is a single opaque number — a Spotter seeing "Dues: ₹340" has no
   * way to know which bookings produced it.
   */
  static async getEarningsBreakdown(req, res) {
    try {
      const days = Math.min(parseInt(req.query.days) || 30, 365);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const bookings = await prisma.bookings.findMany({
        where: {
          status: 'completed',
          created_at: { gte: since },
          parking_spots: { spotter_id: req.user.id },
        },
        include: { parking_spots: { select: { id: true, title: true } } },
        orderBy: { created_at: 'desc' },
        take: 200,
      });

      const items = bookings.map((b) => ({
        booking_id: b.id,
        spot_id: b.parking_spots?.id || null,
        spot_title: b.parking_spots?.title || 'Spot',
        date: b.actual_end_time || b.created_at,
        hours: Number(b.hours || 0),
        total_price: Number(b.total_price || 0),
        platform_fee: Number(b.platform_fee || 0),
        spotter_earning: Number(b.spotter_earning || 0),
        payment_mode: b.payment_mode,
        payment_status: b.payment_status,
        // Cash bookings DEBIT the wallet (fee owed); online bookings CREDIT it.
        wallet_effect: b.payment_mode === 'cash'
          ? -Number(b.platform_fee || 0)
          : Number(b.spotter_earning || 0),
      }));

      // Per-spot rollup so the Spotter can see which spot performs best.
      const bySpotMap = new Map();
      for (const it of items) {
        const key = it.spot_id ?? 'unknown';
        const agg = bySpotMap.get(key) || {
          spot_id: it.spot_id, spot_title: it.spot_title,
          bookings: 0, gross: 0, fees: 0, earnings: 0,
        };
        agg.bookings += 1;
        agg.gross += it.total_price;
        agg.fees += it.platform_fee;
        agg.earnings += it.spotter_earning;
        bySpotMap.set(key, agg);
      }
      const bySpot = Array.from(bySpotMap.values())
        .map((a) => ({
          ...a,
          gross: Number(a.gross.toFixed(2)),
          fees: Number(a.fees.toFixed(2)),
          earnings: Number(a.earnings.toFixed(2)),
        }))
        .sort((a, b) => b.earnings - a.earnings);

      const totals = items.reduce(
        (acc, it) => {
          acc.gross += it.total_price;
          acc.fees += it.platform_fee;
          acc.earnings += it.spotter_earning;
          if (it.payment_mode === 'cash') acc.cash_fees_owed += it.platform_fee;
          return acc;
        },
        { gross: 0, fees: 0, earnings: 0, cash_fees_owed: 0 }
      );

      res.json({
        success: true,
        data: {
          period_days: days,
          totals: {
            gross: Number(totals.gross.toFixed(2)),
            fees: Number(totals.fees.toFixed(2)),
            earnings: Number(totals.earnings.toFixed(2)),
            cash_fees_owed: Number(totals.cash_fees_owed.toFixed(2)),
            bookings: items.length,
          },
          by_spot: bySpot,
          items,
        },
      });
    } catch (error) {
      logger.error('Earnings Breakdown Error:', error);
      res.status(500).json({ success: false, message: 'Failed to retrieve earnings breakdown' });
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

  /**
   * TOGGLE ALL SPOTS (SPOTTER ONLY)
   */
  static async toggleAllSpots(req, res) {
    try {
      if (!req.user.role || req.user.role.toLowerCase() !== 'spotter') {
        return res.status(403).json({
          success: false,
          message: 'Only spotters can toggle spot status'
        });
      }

      const { online } = req.body;
      const is_active = !!online;

      await require('../config/prisma').parking_spots.updateMany({
        where: { spotter_id: req.user.id },
        data: { is_active, updated_at: new Date() }
      });

      logger.info(`Spotter ${req.user.id} toggled all spots to ${is_active ? 'online' : 'offline'}`);

      return res.json({
        success: true,
        message: `All spots toggled to ${is_active ? 'online' : 'offline'} successfully`
      });
    } catch (error) {
      logger.error('Toggle all spots error:', error);
      return res.status(500).json({
        success: false,
        message: 'Error toggling spots'
      });
    }
  }
}

module.exports = SpotController;
