const prisma = require('../config/prisma');
const logger = require('../utils/logger');
const PricingService = require('../services/PricingService');
const CommissionService = require('../services/CommissionService');
const ParkingSpot = require('./ParkingSpot');
const PaymentService = require('../services/paymentService');

class Booking {

  static async create({ user_id, spot_id, start_time, end_time, vehicle_type = 'car', vehicle_subtype = null, slot_name = null, payment_mode = 'online' }) {
    return prisma.$transaction(async (tx) => {
      // 1. Get spot with lock
      const spot = await tx.parking_spots.findUnique({
        where: { id: parseInt(spot_id) }
      });

      if (!spot || !spot.is_active) throw new Error('Parking spot not found');
      
      // Check specific vehicle slots
      if (vehicle_type === 'car') {
        if (spot.car_slots !== null && spot.car_slots <= 0 && spot.available_slots <= 0) {
          logger.error(`Booking failed: No car slots available for spot ${spot_id}`);
          throw new Error('No car slots available');
        }
      } else if (vehicle_type === 'bike') {
        if (spot.bike_slots !== null && spot.bike_slots <= 0 && spot.available_slots <= 0) {
          logger.error(`Booking failed: No bike slots available for spot ${spot_id}`);
          throw new Error('No bike slots available');
        }
      }

      if (spot.available_slots <= 0) {
        logger.error(`Booking failed: No total slots available for spot ${spot_id}`);
        throw new Error('No total slots available');
      }

      const start = new Date(start_time);
      const end = new Date(end_time);
      if (end <= start) throw new Error('Invalid booking duration');

      const diffMs = end - start;
      const hours = Math.max(1, Math.ceil(diffMs / (1000 * 60)) / 60);

      // Calculate Pricing & Commission
      let pricing;
      try {
        pricing = await PricingService.calculatePrice({
          basePrice: Number(spot.price_per_hour),
          locationType: spot.location_type || 'urban',
          spotId: spot.id
        });
      } catch (err) {
        logger.error('Pricing calculation failed, using fallback', err);
        pricing = { finalPrice: Number(spot.price_per_hour) };
      }

      const total_price = Number((hours * pricing.finalPrice).toFixed(2));
      const commission = CommissionService.calculateCommission(total_price, spot.location_type || 'urban');

      const otp_code = Math.floor(100000 + Math.random() * 900000).toString();
      const checkout_otp = Math.floor(100000 + Math.random() * 900000).toString();
      const otp_expires_at = new Date(Date.now() + 30 * 60 * 1000);

      logger.info(`Creating booking record: user=${user_id}, spot=${spot_id}, price=${total_price}`);

      const booking = await tx.bookings.create({
        data: {
          user_id: parseInt(user_id),
          spot_id: parseInt(spot_id),
          vehicle_type,
          vehicle_subtype,
          slot_name,
          start_time: start,
          end_time: end,
          status: 'reserved',
          total_price,
          hours,
          otp_code,
          checkout_otp,
          otp_expires_at,
          platform_fee: commission.platformFee,
          spotter_earning: commission.spotterEarning,
          payment_mode,
          payment_status: payment_mode === 'cash' ? 'pending_cash' : 'pending'
        }
      });

      // 2. Decrease slots
      const updateData = {
        available_slots: { decrement: 1 },
        is_available: (spot.available_slots - 1 > 0)
      };
      
      if (vehicle_type === 'car' && spot.car_slots > 0) updateData.car_slots = { decrement: 1 };
      else if (vehicle_type === 'bike' && spot.bike_slots > 0) updateData.bike_slots = { decrement: 1 };

      await tx.parking_spots.update({
        where: { id: parseInt(spot_id) },
        data: updateData
      });

      logger.info(`Booking created successfully: ${booking.id}`);
      return booking;
    });
  }

  static async verifyOTP(bookingId, otp) {
    return prisma.$transaction(async (tx) => {
      const booking = await tx.bookings.findUnique({
        where: { id: parseInt(bookingId) }
      });

      if (!booking) throw new Error('Booking not found');
      if (booking.status !== 'reserved') throw new Error('Booking is not reserved');
      if (booking.otp_code !== otp) throw new Error('Invalid OTP');
      if (new Date() > new Date(booking.otp_expires_at)) throw new Error('OTP expired');

      return tx.bookings.update({
        where: { id: parseInt(bookingId) },
        data: {
          status: 'active',
          updated_at: new Date()
        }
      });
    });
  }

  static async verifyCheckoutOTP(bookingId, otp) {
    const booking = await prisma.bookings.findUnique({
      where: { id: parseInt(bookingId) }
    });

    if (!booking) throw new Error('Booking not found');
    if (booking.status !== 'active') throw new Error('Booking is not active');
    if (booking.checkout_otp !== otp) throw new Error('Invalid Checkout OTP');

    return this.complete(bookingId);
  }

  static async complete(bookingId, checkoutOtp = null) {
    return prisma.$transaction(async (tx) => {
      const booking = await tx.bookings.findUnique({
        where: { id: parseInt(bookingId) },
        include: {
          parking_spots: {
            include: { users: true }
          }
        }
      });

      if (!booking) throw new Error('Booking not found');
      if (booking.status !== 'active') throw new Error('Booking not active');
      if (checkoutOtp && booking.checkout_otp !== checkoutOtp) throw new Error('Invalid Check-Out OTP');

      const endTime = new Date();
      const startTime = new Date(booking.start_time);
      let diffMs = endTime - startTime;
      if (diffMs < 0) diffMs = 60 * 1000;

      const hours = Math.max(1, Math.ceil(diffMs / (1000 * 60)) / 60);

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

      const updated = await tx.bookings.update({
        where: { id: parseInt(bookingId) },
        data: {
          status: 'completed',
          actual_end_time: endTime,
          total_price: finalPrice,
          hours: hours,
          platform_fee: commission.platformFee,
          spotter_earning: commission.spotterEarning,
          updated_at: new Date()
        }
      });

      // Increase slots
      const updateData = {
        available_slots: { 
          set: Math.min(booking.parking_spots.available_slots + 1, booking.parking_spots.total_slots) 
        },
        is_available: true,
        updated_at: new Date()
      };

      if (booking.vehicle_type === 'car') {
        updateData.car_slots = { increment: 1 };
      } else if (booking.vehicle_type === 'bike') {
        updateData.bike_slots = { increment: 1 };
      }

      await tx.parking_spots.update({
        where: { id: booking.spot_id },
        data: updateData
      });

      // 4. AUTOMATED BILLING (The Uber Experience)
      // Attempt to charge the finder's default payment method immediately.
      try {
        const chargeResult = await PaymentService.chargeUserForBooking(
          booking.user_id, 
          booking.id, 
          finalPrice
        );

        if (chargeResult.success) {
          logger.info(`Automated charge successful for booking ${booking.id}: ${chargeResult.transactionId}`);
          
          // 5. AUTOMATED PAYOUT
          // Split and send money to the spotter
          if (booking.parking_spots.users?.stripe_account_id) {
             await PaymentService.splitAndPayout(
               booking.id, 
               finalPrice, 
               commission.spotterEarning, 
               booking.parking_spots.users.stripe_account_id,
               booking.parking_spots.users.payout_provider || 'stripe'
             );
          }
        }
      } catch (payError) {
        logger.error(`Automated billing failed for booking ${booking.id}:`, payError);
        // Note: We don't fail the completion if payment fails (user might pay manually),
        // but we log it for retry/notification.
      }

      return updated;
    });
  }

  static async expire(bookingId) {
    return prisma.$transaction(async (tx) => {
      const booking = await tx.bookings.findUnique({
        where: { id: parseInt(bookingId) },
        include: { parking_spots: true }
      });

      if (!booking) throw new Error('Booking not found');
      if (booking.status !== 'reserved') throw new Error('Only reserved bookings can be expired');

      await tx.bookings.update({
        where: { id: parseInt(bookingId) },
        data: {
          status: 'expired',
          updated_at: new Date()
        }
      });

      const updateData = {
        available_slots: { increment: 1 },
        is_available: true
      };

      if (booking.vehicle_type === 'car') updateData.car_slots = { increment: 1 };
      else if (booking.vehicle_type === 'bike') updateData.bike_slots = { increment: 1 };

      await tx.parking_spots.update({
        where: { id: booking.spot_id },
        data: updateData
      });
    });
  }

  static async extend(bookingId, userId, additionalHours) {
    return prisma.$transaction(async (tx) => {
      const booking = await tx.bookings.findFirst({
        where: {
          id: parseInt(bookingId),
          user_id: parseInt(userId)
        },
        include: {
          parking_spots: true
        }
      });

      if (!booking) throw new Error('Booking not found or unauthorized');
      if (booking.status !== 'active') throw new Error('Only active bookings can be extended');

      const hoursToAdd = Number(additionalHours);
      const newHours = Number(booking.hours) + hoursToAdd;
      
      const pricing = await PricingService.calculatePrice({
        basePrice: Number(booking.parking_spots.price_per_hour),
        locationType: booking.parking_spots.location_type || 'urban',
        spotId: booking.spot_id
      });
      
      const additionalPrice = Number((hoursToAdd * pricing.finalPrice).toFixed(2));
      const newTotalPrice = Number(booking.total_price) + additionalPrice;
      const newEndTime = new Date(new Date(booking.end_time).getTime() + (hoursToAdd * 60 * 60 * 1000));

      return tx.bookings.update({
        where: { id: parseInt(bookingId) },
        data: {
          hours: newHours,
          total_price: newTotalPrice,
          end_time: newEndTime,
          updated_at: new Date()
        }
      });
    });
  }

  static async cancel(bookingId, userId) {
    return prisma.$transaction(async (tx) => {
      const booking = await tx.bookings.findFirst({
        where: {
          id: parseInt(bookingId),
          user_id: parseInt(userId)
        },
        include: { parking_spots: true }
      });

      if (!booking) throw new Error('Booking not found');
      if (booking.status !== 'reserved') throw new Error('Only reserved bookings can be cancelled');

      await tx.bookings.update({
        where: { id: parseInt(bookingId) },
        data: {
          status: 'cancelled',
          updated_at: new Date()
        }
      });

      const updateData = {
        available_slots: { increment: 1 },
        is_available: true
      };

      if (booking.vehicle_type === 'car') updateData.car_slots = { increment: 1 };
      else if (booking.vehicle_type === 'bike') updateData.bike_slots = { increment: 1 };

      await tx.parking_spots.update({
        where: { id: booking.spot_id },
        data: updateData
      });
    });
  }

  static async updatePaymentMode(bookingId, userId, paymentMode) {
    return prisma.$transaction(async (tx) => {
      const booking = await tx.bookings.findFirst({
        where: {
          id: parseInt(bookingId),
          user_id: parseInt(userId)
        },
        include: {
          parking_spots: true
        }
      });

      if (!booking) throw new Error('Booking not found or unauthorized');
      if (booking.payment_status === 'paid') throw new Error('Booking is already paid');

      const isCash = paymentMode === 'cash';

      const updated = await tx.bookings.update({
        where: { id: parseInt(bookingId) },
        data: {
          payment_mode: paymentMode,
          payment_status: isCash ? 'paid' : 'pending',
          updated_at: new Date()
        }
      });

      if (isCash) {
        // If cash, deduct the platform fee from the Spotter's balance
        const spot = booking.parking_spots;
        if (spot && spot.spotter_id) {
          await tx.users.update({
            where: { id: spot.spotter_id },
            data: {
              balance: {
                decrement: booking.platform_fee || 0
              }
            }
          });
          logger.info(`Cash booking ${bookingId} (updated at checkout): Deducted ₹${booking.platform_fee} from spotter ${spot.spotter_id} wallet`);
        }
      }

      return updated;
    });
  }

  static async findById(id) {
    return prisma.bookings.findUnique({
      where: { id: parseInt(id) },
      include: {
        parking_spots: true,
        users: {
          select: {
            full_name: true,
            email: true
          }
        }
      }
    });
  }

  static async findByUser(userId) {
    return prisma.bookings.findMany({
      where: { user_id: parseInt(userId) },
      include: {
        parking_spots: true
      },
      orderBy: {
        created_at: 'desc'
      }
    });
  }

  static async findBySpotter(spotterId) {
    return prisma.bookings.findMany({
      where: {
        parking_spots: {
          spotter_id: parseInt(spotterId)
        }
      },
      include: {
        parking_spots: true,
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
}

module.exports = Booking;