const prisma = require('../config/prisma');
const logger = require('../utils/logger');

class PricingService {

  /**
   * MAIN METHOD
   */
  static async calculatePrice({ basePrice = null, locationType = null, spotId = null }) {
    try {
      let priceBase = basePrice;
      let location = locationType;
      let totalSlots = 1;

      /**
       * ✅ Fetch from DB if spotId provided
       */
      if (spotId) {
        const spot = await prisma.parking_spots.findUnique({
          where: { id: parseInt(spotId), is_active: true }
        });

        if (!spot) {
          throw new Error('Parking spot not found');
        }

        priceBase = Number(spot.price_per_hour);
        location = spot.location_type || 'urban';
        totalSlots = spot.total_slots || 1;
      }

      /**
       * ❌ Validate base price
       */
      if (!priceBase || isNaN(priceBase)) {
        throw new Error('Base price is required');
      }

      const bookingTime = new Date();
      let multiplier = 1.0;

      /**
       * ⏱ TIME MULTIPLIER (Disabled for Uber-style strictly demand-based pricing)
       */
      const timeMultiplier = 1.0;

      /**
       * 📍 LOCATION MULTIPLIER (Disabled)
       */
      const locationMultiplier = 1.0;

      /**
       * 🔥 DEMAND MULTIPLIER
       */
      let demandMultiplier = 1.0;
      if (spotId) {
        demandMultiplier = await this.calculateDemandMultiplier(spotId, totalSlots);
        multiplier *= demandMultiplier;
      }

      /**
       * 💰 FINAL PRICE
       */
      const finalPrice = Number((priceBase * multiplier).toFixed(2));

      return {
        basePrice: priceBase,
        finalPrice,
        multiplier: Number(multiplier.toFixed(2)),
        breakdown: {
          time: timeMultiplier,
          location: locationMultiplier,
          demand: demandMultiplier,
        },
      };

    } catch (error) {
      logger.error('Error calculating dynamic price:', error);

      /**
       * ⚠️ SAFE FALLBACK (IMPORTANT)
       * Never return 0 if possible
       */
      const safeBase = Number(basePrice) || 50; // default fallback price

      return {
        basePrice: safeBase,
        finalPrice: safeBase,
        multiplier: 1.0,
        breakdown: {
          time: 1.0,
          location: 1.0,
          demand: 1.0
        }
      };
    }
  }

  /**
   * ⏱ TIME-BASED PRICING
   */
  static getTimeMultiplier(date) {
    const hour = date.getHours();
    const day = date.getDay();

    if (day >= 1 && day <= 5 && hour >= 7 && hour < 10) return 1.3;
    if (day >= 1 && day <= 5 && hour >= 17 && hour < 20) return 1.4;
    if (hour >= 22 || hour < 6) return 0.8;
    if ((day === 0 || day === 6) && hour >= 12 && hour < 18) return 1.2;

    return 1.0;
  }

  /**
   * 📍 LOCATION MULTIPLIER
   */
  static getLocationMultiplier(type) {
    const multipliers = {
      urban: 1.5,
      suburban: 1.2,
      rural: 0.9,
    };

    return multipliers[type] || 1.0;
  }

  /**
   * 🔥 AREA-WIDE SURGE MULTIPLIER
   * Uber-style demand calculation based on occupancy in the area.
   */
  static async calculateDemandMultiplier(spotId, totalSlots) {
    try {
      // 1. Get active bookings for this spot
      const activeBookingsCount = await prisma.bookings.count({
        where: {
          spot_id: parseInt(spotId),
          status: 'active'
        }
      });

      const occupancyRatio = totalSlots > 0 ? activeBookingsCount / totalSlots : 0;

      /**
       * SURGE TIERS (Realistic Uber-style multipliers)
       * 100% Full => 2.0x
       * >90% Full => 1.5x
       * >70% Full => 1.2x
       */
      if (occupancyRatio >= 1.0) return 2.0;
      if (occupancyRatio >= 0.9) return 1.5;
      if (occupancyRatio >= 0.7) return 1.2;
      if (occupancyRatio >= 0.5) return 1.1;

      return 1.0;
    } catch (error) {
      logger.error('Error calculating demand multiplier:', error);
      return 1.0;
    }
  }
}

module.exports = PricingService;