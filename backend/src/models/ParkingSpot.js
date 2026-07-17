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

      const { normalizeLocationType } = require('../constants/spotTypes');
      const normalizedLocation = normalizeLocationType(location_type);

      const spot = await prisma.parking_spots.create({
        data: {
          spotter_id: parseInt(spotter_id),
          title,
          description,
          price_per_hour: parseFloat(price_per_hour),
          latitude: parseFloat(latitude),
          longitude: parseFloat(longitude),
          address,
          location_type: normalizedLocation,
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

  static async findNearby(lat, lng, radius = 5) {
    // Uses the lat/lng index for bounding box pre-filter, then Haversine for precision
    const latDelta = radius / 111.0;
    const lngDelta = radius / (111.0 * Math.cos(lat * Math.PI / 180));

    return prisma.$queryRaw`
      SELECT parking_spots.*,
      (
        6371 * acos(
          cos(radians(${lat})) * cos(radians(latitude)) *
          cos(radians(longitude) - radians(${lng})) +
          sin(radians(${lat})) * sin(radians(latitude))
        )
      ) AS distance
      FROM parking_spots
      JOIN users u ON parking_spots.spotter_id = u.id
      WHERE is_active = true
        AND is_available = true
        AND u.balance >= -500
        AND latitude BETWEEN ${lat - latDelta} AND ${lat + latDelta}
        AND longitude BETWEEN ${lng - lngDelta} AND ${lng + lngDelta}
        AND (
          6371 * acos(
            cos(radians(${lat})) * cos(radians(latitude)) *
            cos(radians(longitude) - radians(${lng})) +
            sin(radians(${lat})) * sin(radians(latitude))
          )
        ) < ${radius}
      ORDER BY distance
      LIMIT 50
    `;
  }

  static async findAbsoluteNearest(lat, lng, limit = 5) {
    return prisma.$queryRaw`
      SELECT parking_spots.*,
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
      JOIN users u ON parking_spots.spotter_id = u.id
      WHERE is_active = true
        AND is_available = true
        AND available_slots > 0
        AND u.balance >= -500
      ORDER BY distance ASC
      LIMIT ${limit}
    `;
  }

  static async findAvailable() {
    return prisma.parking_spots.findMany({
      where: {
        is_active: true,
        is_available: true,
        available_slots: { gt: 0 },
        users: {
          balance: { gte: -500 }
        }
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

    const { normalizeLocationType } = require('../constants/spotTypes');
    const normalizedLocation = location_type ? normalizeLocationType(location_type) : undefined;

    return prisma.parking_spots.update({
      where: { id: parseInt(spotId) },
      data: {
        title,
        description,
        price_per_hour: price_per_hour ? parseFloat(price_per_hour) : undefined,
        address,
        location_type: normalizedLocation,
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
        spotter_earning: true
      }
    });

    // Fetch bookings completed in the last 7 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    const recentCompletedBookings = await prisma.bookings.findMany({
      where: {
        parking_spots: {
          spotter_id: parseInt(userId)
        },
        status: 'completed',
        created_at: {
          gte: sevenDaysAgo
        }
      },
      select: {
        created_at: true,
        spotter_earning: true
      }
    });

    // Map to last 7 days trend
    const trend = Array(7).fill(0);
    const today = new Date();
    today.setHours(23, 59, 59, 999); // set to end of today
    
    recentCompletedBookings.forEach(item => {
      const dayDiff = Math.floor((today - new Date(item.created_at)) / (1000 * 60 * 60 * 24));
      if (dayDiff >= 0 && dayDiff < 7) {
        trend[6 - dayDiff] += Number(item.spotter_earning || 0);
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

    // 1. Occupancy Rate Calculation
    const totalSlotsSum = activeSpots.reduce((acc, s) => acc + (s.total_slots || 0), 0);
    const availableSlotsSum = activeSpots.reduce((acc, s) => acc + (s.available_slots || 0), 0);
    const occupiedSlotsSum = Math.max(0, totalSlotsSum - availableSlotsSum);
    const occupancyRate = totalSlotsSum > 0 ? Number(((occupiedSlotsSum / totalSlotsSum) * 100).toFixed(0)) : 0;

    // 2. Average Booking Duration Calculation (completed bookings)
    const avgDurationAgg = await prisma.bookings.aggregate({
      where: {
        parking_spots: {
          spotter_id: parseInt(userId)
        },
        status: 'completed'
      },
      _avg: {
        hours: true
      }
    });
    const avgDuration = avgDurationAgg._avg.hours ? Number(Number(avgDurationAgg._avg.hours).toFixed(1)) : 0.0;

    // 3. Global Online/Offline Status
    const allSpots = await prisma.parking_spots.findMany({
      where: { spotter_id: parseInt(userId) },
      select: { is_active: true }
    });
    const globalOnline = allSpots.length > 0 && allSpots.some(s => s.is_active);

    // 4. Payouts History
    const payoutHistory = await prisma.payouts.findMany({
      where: { user_id: parseInt(userId) },
      orderBy: { created_at: 'desc' },
      take: 5,
      select: {
        id: true,
        amount: true,
        status: true,
        created_at: true,
        mode: true
      }
    });

    return {
      active_spots: activeSpotsCount,
      earnings: Number(earnings._sum.spotter_earning || 0),
      revenue_trend: trend,
      surge_factor: Number(avgSurge.toFixed(1)),
      inventory: activeSpots,
      recent_traffic: recentTraffic,
      occupancy_rate: occupancyRate,
      avg_duration: avgDuration,
      global_online: globalOnline,
      payout_history: payoutHistory
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