const prisma = require('../config/prisma');
const logger = require('../utils/logger');

/** Booking states that are physically holding a bay right now. */
const OCCUPYING_STATUSES = ['reserved', 'active', 'checkout_pending'];

/**
 * Replace a spot's stored availability with the counted truth.
 *
 * `available_slots` is a running counter, incremented and decremented by the
 * booking lifecycle — and a counter is only ever as correct as the last code
 * path that touched it. Cash and arrears checkouts used to close a booking
 * without giving the slot back, so live spots still carry drift from before
 * that was fixed: the map advertised "5 free" while the slot picker, which
 * counts real bookings, offered six.
 *
 * Counting bookings asks exactly the question the slot picker asks, so the two
 * can no longer disagree.
 *
 * @param {object} row  a spot row carrying `taken_now` from a counted join
 */
function withLiveAvailability(row) {
  const total = Number(row.total_slots) || 0;
  const taken = Number(row.taken_now) || 0;
  const free = Math.max(0, total - taken);

  return {
    ...row,
    available_slots: free,
    is_available: free > 0,
    // Kept alongside so a drifted counter is diagnosable rather than silently
    // papered over — if these disagree, something is still leaking.
    available_slots_stored: row.available_slots,
  };
}

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

    const rows = await prisma.$queryRaw`
      SELECT parking_spots.*,
      COALESCE(b.taken, 0)::int AS taken_now,
      (
        6371 * acos(
          cos(radians(${lat})) * cos(radians(latitude)) *
          cos(radians(longitude) - radians(${lng})) +
          sin(radians(${lat})) * sin(radians(latitude))
        )
      ) AS distance
      FROM parking_spots
      JOIN users u ON parking_spots.spotter_id = u.id
      LEFT JOIN (
        SELECT spot_id, COUNT(*)::int AS taken
        FROM bookings
        WHERE status IN ('reserved', 'active', 'checkout_pending')
        GROUP BY spot_id
      ) b ON b.spot_id = parking_spots.id
      WHERE is_active = true
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

    // `is_available` is deliberately no longer in the WHERE clause: it is
    // derived from the same drifting counter, so a spot whose count had leaked
    // to zero switched itself off and stayed invisible however empty it
    // actually was. Filter on the counted truth instead.
    return rows
      .map((r) => withLiveAvailability(r))
      .filter((r) => r.available_slots > 0);
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
    // Same reasoning as findNearby: filtering on the stored counter hid spots
    // that were genuinely free but had drifted to zero. Fetch the active ones
    // and let the counted occupancy decide.
    const spots = await prisma.parking_spots.findMany({
      where: {
        is_active: true,
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

    if (spots.length === 0) return spots;

    // One grouped query for the whole page rather than a count per spot.
    const counts = await prisma.bookings.groupBy({
      by: ['spot_id'],
      where: { spot_id: { in: spots.map((s) => s.id) }, status: { in: OCCUPYING_STATUSES } },
      _count: { _all: true },
    });
    const takenBySpot = new Map(counts.map((c) => [c.spot_id, c._count._all]));

    return spots
      .map((s) => withLiveAvailability({ ...s, taken_now: takenBySpot.get(s.id) || 0 }))
      .filter((s) => s.available_slots > 0);
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

    // ── Earned vs still owed ────────────────────────────────────────
    //
    // This used to sum EVERY completed booking regardless of whether the money
    // was ever collected, and the tile calls it "Total earned / All-time
    // income". A booking the driver never paid for counted the same as one paid
    // in full — so the headline figure could exceed what the host will actually
    // receive. Income you might never see is not income.
    //
    // SETTLED means the host is genuinely owed nothing further:
    //   paid           — collected, online or cash.
    //   unpaid_arrears — the driver left without paying, but the host was still
    //                    credited in full and the debt moved onto the DRIVER
    //                    (see BookingController.checkoutUnpaid). Earned.
    // Anything else (pending, failed) is money in flight, reported separately
    // rather than folded into the total.
    const SETTLED_STATUSES = ['paid', 'unpaid_arrears'];
    const completedForSpotter = {
      parking_spots: { spotter_id: parseInt(userId) },
      status: 'completed',
    };

    const [earnings, pendingEarnings] = await Promise.all([
      prisma.bookings.aggregate({
        where: { ...completedForSpotter, payment_status: { in: SETTLED_STATUSES } },
        _sum: { spotter_earning: true },
      }),
      prisma.bookings.aggregate({
        where: { ...completedForSpotter, NOT: { payment_status: { in: SETTLED_STATUSES } } },
        _sum: { spotter_earning: true },
      }),
    ]);

    // ── 7-day earnings trend ────────────────────────────────────────
    //
    // Two things this gets right that the previous version did not.
    //
    // 1. It buckets by WHEN THE MONEY WAS EARNED (actual_end_time), not when
    //    the booking was created. A booking made on Monday and completed on
    //    Friday belongs to Friday's earnings; bucketing it on Monday put income
    //    on a day the host earned nothing, and the chart is labelled as a
    //    weekly trend of earnings.
    //
    // 2. It buckets in IST. Day boundaries were computed from server time,
    //    which is UTC on Railway, while the chart's day labels are generated on
    //    the phone in IST. Anything completed between midnight and 05:30 IST
    //    fell into the previous day's bar, so the labels and the data disagreed
    //    for exactly the late-night bookings a parking host cares about.
    const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
    /** Midnight IST for a given instant, expressed as a UTC-epoch day marker. */
    const istDayStart = (d) => {
      const shifted = new Date(new Date(d).getTime() + IST_OFFSET_MS);
      return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
    };

    const DAY_MS = 24 * 60 * 60 * 1000;
    const todayIstDay = istDayStart(new Date());
    // The real UTC instant that the 7-day IST window opens at.
    const windowStart = new Date(todayIstDay - 6 * DAY_MS - IST_OFFSET_MS);

    const recentCompletedBookings = await prisma.bookings.findMany({
      where: {
        parking_spots: {
          spotter_id: parseInt(userId)
        },
        status: 'completed',
        // Completion time where we have it; fall back to created_at for older
        // rows written before actual_end_time was recorded, so their earnings
        // do not silently vanish from the chart.
        OR: [
          { actual_end_time: { gte: windowStart } },
          { AND: [{ actual_end_time: null }, { created_at: { gte: windowStart } }] },
        ],
      },
      select: {
        created_at: true,
        actual_end_time: true,
        spotter_earning: true
      }
    });

    const trend = Array(7).fill(0);
    recentCompletedBookings.forEach(item => {
      const earnedAt = item.actual_end_time || item.created_at;
      if (!earnedAt) return;
      const dayDiff = Math.round((todayIstDay - istDayStart(earnedAt)) / DAY_MS);
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

    // Surge for every spot from ONE query, not one query per spot.
    //
    // This was a loop calling calculateDemandMultiplier per spot — each of
    // which runs its own COUNT, and awaited sequentially. A host with ten
    // spots paid ten round trips, and this dashboard refetches on every
    // booking event, every push, every reconnect and every screen focus.
    //
    // groupBy returns only spots that HAVE active bookings, so a missing entry
    // means zero — which is why the lookup below defaults to 0 rather than
    // assuming every spot appears.
    const PricingService = require('../services/PricingService');
    const activeSpotIds = activeSpots.map((s) => s.id);
    const activeCounts = activeSpotIds.length
      ? await prisma.bookings.groupBy({
          by: ['spot_id'],
          where: { spot_id: { in: activeSpotIds }, status: 'active' },
          _count: { _all: true },
        })
      : [];
    const activeBySpot = new Map(activeCounts.map((r) => [r.spot_id, r._count?._all || 0]));

    const totalSurge = activeSpots.reduce(
      (acc, spot) =>
        acc + PricingService.demandMultiplierFor(activeBySpot.get(spot.id) || 0, spot.total_slots),
      0
    );
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
      // Completed, but the money has not been collected yet. Surfaced so the
      // dashboard can say so plainly instead of quietly counting it as income.
      pending_earnings: Number(pendingEarnings._sum.spotter_earning || 0),
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