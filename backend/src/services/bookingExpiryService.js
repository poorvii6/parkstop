const cron = require('node-cron');
const prisma = require('../config/prisma');
const logger = require('../utils/logger');
const PricingService = require('../services/PricingService');
const CommissionService = require('../services/CommissionService');

const startBookingExpiryJob = () => {
  // Run every minute
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();

      /**
       * 1️⃣ EXPIRE RESERVED BOOKINGS
       * Bookings that weren't verified via OTP within 30 mins
       */
      const expiredReserved = await prisma.bookings.findMany({
        where: {
          status: 'reserved',
          otp_expires_at: { lte: now }
        }
      });

      if (expiredReserved.length > 0) {
        logger.info(`Cleaning up ${expiredReserved.length} expired reservations...`);
        
        for (let booking of expiredReserved) {
          const updateData = { 
            available_slots: { increment: 1 },
            is_available: true
          };
          if (booking.vehicle_type === 'car') updateData.car_slots = { increment: 1 };
          else if (booking.vehicle_type === 'bike') updateData.bike_slots = { increment: 1 };

          await prisma.$transaction([
            prisma.bookings.update({
              where: { id: booking.id },
              data: { status: 'expired', updated_at: now }
            }),
            prisma.parking_spots.update({
              where: { id: booking.spot_id },
              data: updateData
            })
          ]);
        }
      }

      /**
       * 2️⃣ AUTO-COMPLETE ACTIVE BOOKINGS
       * Bookings that reached their end_time
       */
      const activeExpired = await prisma.bookings.findMany({
        where: {
          status: 'active',
          end_time: { lte: now }
        },
        include: {
          parking_spots: true
        }
      });

      if (activeExpired.length > 0) {
        logger.info(`Auto-completing ${activeExpired.length} finished bookings...`);

        for (let booking of activeExpired) {
          const startTime = new Date(booking.start_time);
          const minutes = Math.max(1, Math.ceil((now - startTime) / (1000 * 60)));
          const hours = minutes / 60;

          const pricing = await PricingService.calculatePrice({
            basePrice: Number(booking.parking_spots.price_per_hour),
            locationType: booking.parking_spots.location_type || 'urban',
            spotId: booking.spot_id
          });

          const finalPrice = Number((hours * pricing.finalPrice).toFixed(2));
          const commission = CommissionService.calculateCommission(
            finalPrice,
            booking.parking_spots.location_type || 'urban'
          );

          const updateData = { 
            available_slots: { increment: 1 },
            is_available: true
          };
          if (booking.vehicle_type === 'car') updateData.car_slots = { increment: 1 };
          else if (booking.vehicle_type === 'bike') updateData.bike_slots = { increment: 1 };

          await prisma.$transaction([
            prisma.bookings.update({
              where: { id: booking.id },
              data: {
                status: 'completed',
                actual_end_time: now,
                total_price: finalPrice,
                hours: hours,
                platform_fee: commission.platformFee,
                spotter_earning: commission.spotterEarning,
                updated_at: now
              }
            }),
            prisma.parking_spots.update({
              where: { id: booking.spot_id },
              data: updateData
            })
          ]);
        }
      }

    } catch (error) {
      logger.error('Booking lifecycle job error:', error);
    }
  });

  logger.info('✅ Booking expiry job service initialized');
};

module.exports = startBookingExpiryJob;