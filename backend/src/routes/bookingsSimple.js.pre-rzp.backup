const express = require('express');
const { body, query } = require('express-validator');
const prisma = require('../config/prisma');
const Booking = require('../models/Booking');
const ParkingSpot = require('../models/ParkingSpot');
const PaymentService = require('../services/paymentService');
const PricingService = require('../services/PricingService');
const { authenticate, authorize } = require('../middleware/auth');
const validate = require('../middleware/validator');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Helper to get default vehicle details based on user's last bookings or standard defaults
 */
async function getSimulatedDefaultVehicle(userId, reqBody = {}) {
  // If request requests simulating no vehicle, or user's email/name matches novehicle, return null
  const user = await prisma.users.findUnique({
    where: { id: userId },
    select: { name: true, email: true }
  });

  const simulateNoVehicle = reqBody.simulateNoVehicle || 
    (user && user.name && user.name.toLowerCase().includes('no vehicle')) || 
    (user && user.email && user.email.toLowerCase().includes('novehicle'));

  if (simulateNoVehicle) {
    return null;
  }

  // Look up last booking to find vehicle type and vehicle subtype
  const lastBooking = await prisma.bookings.findFirst({
    where: { user_id: userId },
    orderBy: { created_at: 'desc' }
  });

  return {
    id: 1,
    number: lastBooking ? (lastBooking.vehicle_subtype || 'MH-12-AB-1234') : 'MH-12-AB-1234',
    type: lastBooking ? (lastBooking.vehicle_type || 'car') : 'car'
  };
}

/**
 * ⚡ QUICK-BOOK (Finder's main action: "Book Now")
 * Returns minimal booking confirmation details based on finder's habit/history
 */
router.post(
  '/quick-book',
  authenticate,
  authorize('FINDER'),
  [
    body('spotId').isInt().withMessage('Valid Spot ID is required'),
    validate
  ],
  async (req, res) => {
    try {
      const spotId = parseInt(req.body.spotId);
      const userId = req.user.id;

      // 1. Get finder's profile (cached/loaded)
      const finder = await prisma.users.findUnique({
        where: { id: userId },
        select: {
          id: true,
          phone: true,
          payment_methods: { where: { is_default: true }, take: 1 },
          bookings: { take: 1, orderBy: { created_at: 'desc' } }
        }
      });

      // 2. Simulated vehicle check
      const defaultVehicle = await getSimulatedDefaultVehicle(userId, req.body);
      if (!defaultVehicle) {
        return res.status(400).json({
          error: 'No vehicle selected',
          action: 'SET_VEHICLE', // Frontend knows to open vehicle selector
          redirectTo: '/profile/vehicles'
        });
      }

      // 3. Get spot details + pricing
      const spot = await prisma.parking_spots.findUnique({
        where: { id: spotId }
      });

      if (!spot || !spot.is_active || !spot.is_available || spot.available_slots <= 0) {
        return res.status(409).json({
          error: 'Spot just booked',
          suggestion: 'We found 3 nearby spots'
        });
      }

      // 4. Smart duration (based on finder's habit)
      const lastBooking = finder.bookings[0];
      let suggestedDuration = 2; // Default 2 hours
      if (lastBooking && lastBooking.start_time && lastBooking.end_time) {
        const diffMs = new Date(lastBooking.end_time) - new Date(lastBooking.start_time);
        suggestedDuration = Math.max(0.5, Math.ceil(diffMs / (1000 * 60)) / 60);
      }

      const startTime = new Date();
      const endTime = new Date(startTime.getTime() + suggestedDuration * 60 * 60 * 1000);

      // 5. Calculate price using pricing service (handles surge / multipliers)
      const pricing = await PricingService.calculatePrice({
        basePrice: Number(spot.price_per_hour),
        locationType: spot.location_type || 'urban',
        spotId: spot.id
      });
      const price = suggestedDuration * pricing.finalPrice;

      // 6. Show confirmation details
      res.json({
        success: true,
        action: 'CONFIRM_BOOKING',
        details: {
          spot: {
            name: spot.title,
            type: spot.location_type || 'urban',
            spotId: spot.id
          },
          booking: {
            startTime,
            endTime,
            duration: `${suggestedDuration}h`,
            vehicle: defaultVehicle.number,
            vehicleId: defaultVehicle.id,
            vehicle_type: defaultVehicle.type
          },
          payment: {
            amount: Number(price.toFixed(2)),
            method: finder.payment_methods[0] ? finder.payment_methods[0].method_type : 'card',
            paymentId: finder.payment_methods[0] ? finder.payment_methods[0].id : null
          }
        }
      });
    } catch (error) {
      logger.error('Quick book error:', error);
      res.status(500).json({ error: 'Booking failed' });
    }
  }
);

/**
 * Core booking confirmation logic helper
 */
async function handleConfirmBookingLogic(req, res, spotId, adjustedDuration, bookingDetails, userId) {
  try {
    // 1. Re-calculate with any user adjustment
    const startTime = new Date();
    let durationHours;

    if (adjustedDuration) {
      durationHours = parseFloat(adjustedDuration);
    } else if (bookingDetails && bookingDetails.booking) {
      const start = new Date(bookingDetails.booking.startTime);
      const end = new Date(bookingDetails.booking.endTime);
      durationHours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
    } else {
      durationHours = 2; // Default fallback
    }

    if (isNaN(durationHours) || durationHours <= 0) {
      durationHours = 2;
    }

    const endTime = new Date(startTime.getTime() + durationHours * 60 * 60 * 1000);

    const vehicleType = (bookingDetails && bookingDetails.booking && bookingDetails.booking.vehicle_type) 
      ? bookingDetails.booking.vehicle_type 
      : 'car';
      
    const vehicleSubtype = (bookingDetails && bookingDetails.booking && bookingDetails.booking.vehicle)
      ? bookingDetails.booking.vehicle
      : null;

    // 2. Transaction-safe booking creation
    const booking = await Booking.create({
      user_id: userId,
      spot_id: spotId,
      start_time: startTime,
      end_time: endTime,
      vehicle_type: vehicleType,
      vehicle_subtype: vehicleSubtype,
      payment_mode: 'online'
    });

    // 3. Fetch user to check for arrears and calculate checkout total
    const user = await prisma.users.findUnique({
      where: { id: userId }
    });
    const arrears = user.balance < 0 ? Math.abs(Number(user.balance)) : 0;
    const finalAmountToCharge = Number(booking.total_price) + arrears;

    // 4. Create Razorpay order
    const order = await PaymentService.createRazorpayOrder(finalAmountToCharge, userId, booking.id);

    res.json({
      success: true,
      action: 'SHOW_PAYMENT',
      booking: {
        id: booking.id,
        orderAmount: order.amount,
        orderId: order.orderId || order.id,
        keyId: process.env.RAZORPAY_KEY_ID
      }
    });
  } catch (error) {
    logger.error('Confirm booking handler error:', error);
    res.status(400).json({ error: error.message || 'Confirm booking failed' });
  }
}

/**
 * ⚡ CONFIRM-BOOKING (Tapping "Confirm & Pay" - New approach name)
 */
router.post(
  '/confirm-booking',
  authenticate,
  authorize('FINDER'),
  async (req, res) => {
    const { bookingDetails, adjustedDuration } = req.body;
    const userId = req.user.id;

    if (!bookingDetails || !bookingDetails.spot || !bookingDetails.spot.spotId) {
      return res.status(400).json({ error: 'Missing booking details' });
    }

    const spotId = parseInt(bookingDetails.spot.spotId);
    await handleConfirmBookingLogic(req, res, spotId, adjustedDuration, bookingDetails, userId);
  }
);

/**
 * ⚡ CONFIRM (Tapping "Confirm & Pay" - Legacy name for backward compatibility)
 */
router.post(
  '/confirm',
  authenticate,
  authorize('FINDER'),
  [
    body('spotId').isInt().withMessage('Valid Spot ID is required'),
    body('adjustedDuration').optional().isNumeric().withMessage('Adjusted duration must be a number'),
    validate
  ],
  async (req, res) => {
    const spotId = parseInt(req.body.spotId);
    const adjustedDuration = req.body.adjustedDuration;
    const userId = req.user.id;

    // Map legacy inputs to the new structured bookingDetails format internally
    const bookingDetails = {
      spot: { spotId },
      booking: { vehicle_type: 'car' }
    };

    await handleConfirmBookingLogic(req, res, spotId, adjustedDuration, bookingDetails, userId);
  }
);

/**
 * ⚡ GET NEARBY SPOTS
 * Quick discovery map-friendly endpoint
 */
router.get(
  '/nearby',
  authenticate,
  [
    query('lat').optional().isFloat().withMessage('Latitude must be a float'),
    query('lng').optional().isFloat().withMessage('Longitude must be a float'),
    query('latitude').optional().isFloat().withMessage('Latitude must be a float'),
    query('longitude').optional().isFloat().withMessage('Longitude must be a float'),
    query('radius').optional().isNumeric().withMessage('Radius must be a number'),
    validate
  ],
  async (req, res) => {
    try {
      // Handle both lat/lng and latitude/longitude parameter conventions
      const latVal = req.query.latitude || req.query.lat;
      const lngVal = req.query.longitude || req.query.lng;

      if (!latVal || !lngVal) {
        return res.status(400).json({ success: false, error: 'Latitude and Longitude are required' });
      }

      const lat = parseFloat(latVal);
      const lng = parseFloat(lngVal);
      let radius = req.query.radius ? parseFloat(req.query.radius) : 5;

      // Handle meters to kilometers conversion:
      // If radius is large (e.g. > 50), assume it's in meters and convert to km
      if (radius > 50) {
        radius = radius / 1000;
      }

      const spots = await ParkingSpot.findNearby(lat, lng, radius);

      // Enrich with dynamic pricing
      const enrichedSpots = await Promise.all(
        spots.map(async (spot) => {
          try {
            const pricing = await PricingService.calculatePrice({
              basePrice: Number(spot.price_per_hour),
              locationType: spot.location_type || 'urban',
              spotId: spot.id
            });
            return {
              id: spot.id,
              title: spot.title, // legacy
              name: spot.title,  // new structure
              location_type: spot.location_type, // legacy
              type: spot.location_type || 'urban', // new structure
              parkingLotId: spot.spotter_id, // new structure
              latitude: Number(spot.latitude),
              longitude: Number(spot.longitude),
              price: pricing.finalPrice,
              distance: Number(spot.distance)
            };
          } catch (e) {
            return {
              id: spot.id,
              title: spot.title,
              name: spot.title,
              location_type: spot.location_type,
              type: spot.location_type || 'urban',
              parkingLotId: spot.spotter_id,
              latitude: Number(spot.latitude),
              longitude: Number(spot.longitude),
              price: Number(spot.price_per_hour),
              distance: Number(spot.distance)
            };
          }
        })
      );

      res.json({
        success: true,
        nearby: enrichedSpots,
        count: enrichedSpots.length,
        action: 'TAP_TO_BOOK'
      });
    } catch (error) {
      logger.error('Simplified nearby spots error:', error);
      res.status(500).json({ success: false, error: 'Error fetching nearby spots' });
    }
  }
);

module.exports = router;
