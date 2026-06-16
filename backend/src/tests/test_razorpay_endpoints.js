const prisma = require('../config/prisma');
const Booking = require('../models/Booking');
const PaymentController = require('../controllers/paymentController');
const crypto = require('crypto');

async function testRazorpayEndpoints() {
  console.log('🚀 Starting Razorpay Integration Tests...');

  try {
    // 1. Setup Mock Finder
    const finder = await prisma.users.upsert({
      where: { email: 'finder_test_rzp@parkstop.com' },
      update: {},
      create: {
        name: 'Razorpay Test Finder',
        email: 'finder_test_rzp@parkstop.com',
        password: 'hashed_password',
        role: 'finder'
      }
    });

    const spotter = await prisma.users.upsert({
      where: { email: 'spotter_test_rzp@parkstop.com' },
      update: {},
      create: {
        name: 'Razorpay Test Spotter',
        email: 'spotter_test_rzp@parkstop.com',
        password: 'hashed_password',
        role: 'spotter'
      }
    });

    // 2. Setup Mock Spot
    const spot = await prisma.parking_spots.create({
      data: {
        spotter_id: spotter.id,
        title: 'Razorpay Test Spot',
        price_per_hour: 20.00,
        latitude: 12.9716,
        longitude: 77.5946,
        location_type: 'urban'
      }
    });

    // 3. Create Booking
    const booking = await Booking.create({
      user_id: finder.id,
      spot_id: spot.id,
      start_time: new Date(),
      end_time: new Date(Date.now() + 60 * 60 * 1000) // 1 hour
    });

    console.log(`\n✅ Test Setup Ready. Booking ID: ${booking.id}, Total Price: ₹${booking.total_price}`);

    // Mock Express Request and Response for creating Razorpay Order
    let responseData = null;
    let responseStatus = 200;

    const mockReqCreate = {
      user: { id: finder.id, role: 'finder' },
      body: { bookingId: booking.id }
    };

    const mockResCreate = {
      status: function(code) {
        responseStatus = code;
        return this;
      },
      json: function(data) {
        responseData = data;
        return this;
      }
    };

    console.log('\n🔄 Simulating PaymentController.createRazorpayOrder...');
    await PaymentController.createRazorpayOrder(mockReqCreate, mockResCreate);

    if (responseStatus !== 200 || !responseData.success) {
      throw new Error(`Create Order Endpoint Failed! Status: ${responseStatus}, Data: ${JSON.stringify(responseData)}`);
    }

    console.log('✅ createRazorpayOrder verified successfully!');
    console.log('Returned Data:', responseData);

    const { order_id, amount, currency } = responseData;
    if (!order_id) {
      throw new Error('Order ID was not returned by Razorpay');
    }

    // Now, simulate the frontend completing payment
    // We generate a valid HMAC-SHA256 signature using the SECRET key
    const payment_id = 'pay_fake_rzp_payment_123';
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(order_id + '|' + payment_id)
      .digest('hex');

    console.log(`\n🔑 Generated Mock Signature: ${expectedSignature}`);

    // Mock Express Request and Response for verifying Razorpay payment
    let verifyResponseData = null;
    let verifyResponseStatus = 200;

    const mockReqVerify = {
      user: { id: finder.id, role: 'finder' },
      body: {
        bookingId: booking.id,
        razorpay_order_id: order_id,
        razorpay_payment_id: payment_id,
        razorpay_signature: expectedSignature
      }
    };

    const mockResVerify = {
      status: function(code) {
        verifyResponseStatus = code;
        return this;
      },
      json: function(data) {
        verifyResponseData = data;
        return this;
      }
    };

    console.log('\n🔄 Simulating PaymentController.verifyRazorpayPayment...');
    await PaymentController.verifyRazorpayPayment(mockReqVerify, mockResVerify);

    if (verifyResponseStatus !== 200 || !verifyResponseData.success) {
      throw new Error(`Verify Payment Endpoint Failed! Status: ${verifyResponseStatus}, Data: ${JSON.stringify(verifyResponseData)}`);
    }

    console.log('✅ verifyRazorpayPayment verified successfully!');
    console.log('Returned Data:', verifyResponseData);

    // Double check DB state
    const updatedBooking = await prisma.bookings.findUnique({
      where: { id: booking.id }
    });

    console.log('\n🔄 Checking database updates...');
    console.log(`- payment_id: ${updatedBooking.payment_id}`);
    console.log(`- payment_status: ${updatedBooking.payment_status}`);

    if (updatedBooking.payment_status !== 'paid' || updatedBooking.payment_id !== payment_id) {
      throw new Error('Database updates were not correctly verified/committed!');
    }

    console.log('\n🎉 All Razorpay backend integration tests passed successfully!');

  } catch (error) {
    console.error('\n❌ Integration Test Failed:', error);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

testRazorpayEndpoints();
