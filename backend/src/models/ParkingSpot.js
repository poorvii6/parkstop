const prisma = require('../config/prisma');
const logger = require('../utils/logger');

class ParkingSpot {

  static async create(data) {
    try {
      const {
        spotter_id,
        title,
        description,
        price_per_hour,
        latitude,
        longitude,
        address,
        location_type = 'urban',
        amenities = [],
        total_slots = 1,
        car_slots = 1,
        bike_slots = 0,
        images = []
      } = data;

      const spot = await prisma.parking_spots.create({
        data: {
          spotter_id: parseInt(spotter_id),
          title,
          description,
          price_per_hour: parseFloat(price_per_hour),
          latitude: parseFloat(latitude),
          longitude: parseFloat(longitude),
          address,
          location_type,
          amenities: Array.isArray(amenities) ? amenities : [],
          total_slots: parseInt(total_slots),
          available_slots: parseInt(total_slots),
          car_slots: parseInt(car_slots),
          bike_slots: parseInt(bike_slots),
          images: Array.isArray(images) ? images : [],
          is_available: true,
          is_active: true
        }
      });

      return spot;
    } catch (error) {
      logger.error('Error creating parking spot:', error);
      throw error;
    }
  }

  static async findById(id) {
    return prisma.parking_spots.findFirst({
      where: {
        id: parseInt(id),
        is_active: true
      },
      include: {
        users: {
          select: {
            full_name: true,
            phone: true
          }
        }
      }
    });
  }

  static async findNearby(lat, lng, radius) {
    // Prisma doesn't support distance calcs in findMany, use raw query
    return prisma.$queryRaw`
      SELECT *,
      (
        6371 *
        acos(
          cos(radians(${lat})) *
          cos(radians(latitude)) *
          cos(radians(longitude) - radians(${lng})) +
          sin(radians(${lat})) *
          sin(radians(latitude))
        )
      ) AS distance
      FROM parking_spots
      WHERE is_active = true
      AND (
        6371 *
        acos(
          cos(radians(${lat})) *
          cos(radians(latitude)) *
          cos(radians(longitude) - radians(${lng})) +
          sin(radians(${lat})) *
          sin(radians(latitude))
        )
      ) < ${radius}
      ORDER BY distance
    `;
  }

  static async findAbsoluteNearest(lat, lng, limit = 5) {
    return prisma.$queryRaw`
      SELECT *,
      (
        6371 *
        acos(
          cos(radians(${lat})) *
          cos(radians(latitude)) *
          cos(radians(longitude) - radians(${lng})) +
          sin(radians(${lat})) *
          sin(radians(latitude))
        )
      ) AS distance
      FROM parking_spots
      WHERE is_active = true
        AND is_available = true
        AND available_slots > 0
      ORDER BY distance ASC
      LIMIT ${limit}
    `;
  }

  static async findAvailable() {
    return prisma.parking_spots.findMany({
      where: {
        is_active: true,
        is_available: true,
        available_slots: { gt: 0 }
      },
      include: {
        users: {
          select: {
            full_name: true
          }
        }
      },
      orderBy: {
        created_at: 'desc'
      }
    });
  }

  static async update(spotId, userId, updates) {
    const {
      title,
      description,
      price_per_hour,
      address,
      location_type,
      amenities,
      car_slots,
      bike_slots,
      total_slots,
      images
    } = updates;

    return prisma.parking_spots.update({
      where: { id: parseInt(spotId) },
      data: {
        title,
        description,
        price_per_hour: price_per_hour ? parseFloat(price_per_hour) : undefined,
        address,
        location_type,
        amenities: Array.isArray(amenities) ? amenities : undefined,
        car_slots: car_slots !== undefined ? parseInt(car_slots) : undefined,
        bike_slots: bike_slots !== undefined ? parseInt(bike_slots) : undefined,
        total_slots: total_slots !== undefined ? parseInt(total_slots) : undefined,
        images: Array.isArray(images) ? images : undefined,
        updated_at: new Date()
      }
    });
  }

  static async delete(id, userId) {
    await prisma.parking_spots.update({
      where: { id: parseInt(id) },
      data: {
        is_active: false,
        updated_at: new Date()
      }
    });
  }

  static async decreaseSlot(spotId, client = prisma) {
    const spot = await client.parking_spots.update({
      where: { id: parseInt(spotId) },
      data: {
        available_slots: { decrement: 1 },
        updated_at: new Date()
      }
    });

    if (spot.available_slots <= 0) {
      await client.parking_spots.update({
        where: { id: parseInt(spotId) },
        data: { is_available: false }
      });
    }

    return spot;
  }

  static async increaseSlot(spotId, client = prisma) {
    const spot = await client.parking_spots.findUnique({ where: { id: parseInt(spotId) } });
    if (!spot) return;

    await client.parking_spots.update({
      where: { id: parseInt(spotId) },
      data: {
        available_slots: { 
          set: Math.min(spot.available_slots + 1, spot.total_slots) 
        },
        is_available: true,
        updated_at: new Date()
      }
    });
  }

  static async getSpotterDashboard(userId) {
    const activeSpotsCount = await prisma.parking_spots.count({
      where: {
        spotter_id: parseInt(userId),
        is_active: true
      }
    });

    const earnings = await prisma.bookings.aggregate({
      where: {
        parking_spots: {
          spotter_id: parseInt(userId)
        },
        status: 'completed'
      },
      _sum: {
        total_price: true
      }
    });

    const revenueByDay = await prisma.bookings.groupBy({
      by: ['created_at'],
      where: {
        parking_spots: {
          spotter_id: parseInt(userId)
        },
        status: 'completed'
      },
      _sum: {
        total_price: true
      }
    });

    // Map to last 7 days trend (simplified for now)
    const trend = Array(7).fill(0);
    const today = new Date();
    revenueByDay.forEach(item => {
      const dayDiff = Math.floor((today - new Date(item.created_at)) / (1000 * 60 * 60 * 24));
      if (dayDiff >= 0 && dayDiff < 7) {
        trend[6 - dayDiff] += Number(item._sum.total_price || 0);
      }
    });

    // Calculate Current Surge Factor (Average for their active spots)
    const activeSpots = await prisma.parking_spots.findMany({
      where: { spotter_id: parseInt(userId), is_active: true },
      select: {
        id: true,
        title: true,
        total_slots: true,
        available_slots: true,
        car_slots: true,
        bike_slots: true,
      }
    });

    let totalSurge = 0;
    const PricingService = require('../services/PricingService');
    for (const spot of activeSpots) {
      const surge = await PricingService.calculateDemandMultiplier(spot.id, spot.total_slots);
      totalSurge += surge;
    }
    const avgSurge = activeSpots.length > 0 ? (totalSurge / activeSpots.length) : 1.0;

    const recentTraffic = await prisma.bookings.findMany({
      where: {
        parking_spots: {
          spotter_id: parseInt(userId)
        }
      },
      orderBy: { updated_at: 'desc' },
      take: 5,
      select: {
        id: true,
        status: true,
        total_price: true,
        vehicle_type: true,
        vehicle_subtype: true,
        slot_name: true,
        parking_spots: {
          select: {
            title: true
          }
        }
      }
    });

    return {
      active_spots: activeSpotsCount,
      earnings: Number(earnings._sum.total_price || 0),
      revenue_trend: trend,
      surge_factor: Number(avgSurge.toFixed(1)),
      inventory: activeSpots,
      recent_traffic: recentTraffic
    };
  }

  static async isOwner(spotId, userId) {
    const spot = await prisma.parking_spots.findUnique({
      where: { id: parseInt(spotId) },
      select: { spotter_id: true }
    });
    return spot?.spotter_id === parseInt(userId);
  }
}

module.exports = ParkingSpot;