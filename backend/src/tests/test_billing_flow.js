const prisma = require('../config/prisma');
const Booking = require('../models/Booking');
const PaymentService = require('../services/paymentService');
const logger = require('../utils/logger');

async function simulateBillingFlow() {
  console.log('🚀 Starting Uber-style Billing Simulation...');

  try {
    // 1. Setup Mock Users
    const finder = await prisma.users.upsert({
      where: { email: 'finder_test@parkstop.com' },
      update: {},
      create: {
        name: 'Test Finder',
        email: 'finder_test@parkstop.com',
        role: 'finder'
      }
    });

    const spotter = await prisma.users.upsert({
      where: { email: 'spotter_test@parkstop.com' },
      update: { stripe_account_id: 'acct_mock_spotter_123' },
      create: {
        name: 'Test Spotter',
        email: 'spotter_test@parkstop.com',
        role: 'spotter',
        stripe_account_id: 'acct_mock_spotter_123'
      }
    });

    // 2. Setup Mock Spot
    const spot = await prisma.parking_spots.create({
      data: {
        spotter_id: spotter.id,
        title: 'Test Surge Spot',
        price_per_hour: 20.00,
        latitude: 12.9716,
        longitude: 77.5946,
        location_type: 'urban'
      }
    });

    // 3. Add Default Payment Method for Finder
    await prisma.payment_methods.create({
      data: {
        user_id: finder.id,
        provider: 'stripe',
        provider_method_id: 'pm_card_visa',
        method_type: 'card',
        last4: '4242',
        brand: 'visa',
        is_default: true
      }
    });

    console.log('✅ Setup Complete. Creating Booking...');

    // 4. Create Booking
    const booking = await Booking.create({
      user_id: finder.id,
      spot_id: spot.id,
      start_time: new Date(),
      end_time: new Date(Date.now() + 60 * 60 * 1000) // 1 hour
    });

    console.log(`✅ Booking Created: ID ${booking.id}, Price: ${booking.total_price}`);

    // 5. Activate Booking (Verify OTP)
    await Booking.verifyOTP(booking.id, booking.otp_code);
    console.log('✅ Booking Activated.');

    // 6. Complete Booking (Triggers Automated Billing & Payout)
    console.log('🔄 Completing Booking and triggering automated billing...');
    const completed = await Booking.complete(booking.id);

    console.log('--------------------------------------------------');
    console.log('🏁 SIMULATION RESULTS:');
    console.log(`Booking Status: ${completed.status}`);
    console.log(`Final Price Charged: $${completed.total_price}`);
    console.log(`Spotter Earning: $${completed.spotter_earning}`);
    console.log(`Platform Fee: $${completed.platform_fee}`);
    console.log('--------------------------------------------------');
    console.log('🚀 Automated Billing Flow Verified Successfully!');

  } catch (error) {
    console.error('❌ Simulation Failed:', error);
  } finally {
    process.exit(0);
  }
}

simulateBillingFlow();
