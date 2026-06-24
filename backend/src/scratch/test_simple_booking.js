const request = require('supertest');
const { app, server } = require('../server');
const prisma = require('../config/prisma');
const bcrypt = require('bcryptjs');

async function run() {
  try {
    console.log('--- STARTING SIMPLIFIED FINDER WORKFLOW TEST ---');

    // 1. Create a test finder user
    const email = `test_finder_${Date.now()}@example.com`;
    const password = 'password123';
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.users.create({
      data: {
        email,
        password: hashedPassword,
        name: 'Test Finder Simple',
        role: 'finder',
        balance: 0.00
      }
    });
    console.log(`Created test finder user: ${user.email}`);

    // 2. Create a test spotter and a spot to book
    const spotterEmail = `test_spotter_${Date.now()}@example.com`;
    const spotter = await prisma.users.create({
      data: {
        email: spotterEmail,
        password: hashedPassword,
        name: 'Test Spotter Simple',
        role: 'spotter',
        balance: 0.00
      }
    });

    const spot = await prisma.parking_spots.create({
      data: {
        spotter_id: spotter.id,
        title: 'Simple Test Spot',
        price_per_hour: 15.00,
        latitude: 12.971598,
        longitude: 77.594562,
        is_available: true,
        total_slots: 1,
        available_slots: 1
      }
    });
    console.log(`Created test spot: ${spot.title} (ID: ${spot.id})`);

    // 3. Login finder to get JWT token
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password });

    if (loginRes.status !== 200) {
      throw new Error(`Login failed: ${JSON.stringify(loginRes.body)}`);
    }

    const token = loginRes.body.data.access_token;
    console.log('Logged in successfully, token retrieved.');

    // 4. Test GET /api/v1/bookings-simple/nearby with new latitude/longitude parameter naming
    console.log('\nTesting GET /api/v1/bookings-simple/nearby (new parameters)...');
    const nearbyRes = await request(app)
      .get('/api/v1/bookings-simple/nearby')
      .query({ latitude: 12.971598, longitude: 77.594562, radius: 500 }) // 500m radius
      .set('Authorization', `Bearer ${token}`);

    console.log(`Status: ${nearbyRes.status}`);
    console.log(`Body: ${JSON.stringify(nearbyRes.body, null, 2)}`);
    if (nearbyRes.status !== 200 || !nearbyRes.body.nearby || nearbyRes.body.nearby.length === 0) {
      throw new Error('GET /nearby failed or returned no spots');
    }

    // Verify presence of template-specific keys
    const returnedSpot = nearbyRes.body.nearby[0];
    if (!returnedSpot.type || !returnedSpot.name) {
      throw new Error('GET /nearby did not return template-compatible keys (type, name)');
    }

    // 5. Test POST /api/v1/bookings-simple/quick-book (No vehicle simulated)
    console.log('\nTesting POST /api/v1/bookings-simple/quick-book (simulating NO vehicle)...');
    const quickBookNoVehicleRes = await request(app)
      .post('/api/v1/bookings-simple/quick-book')
      .send({ spotId: spot.id, simulateNoVehicle: true })
      .set('Authorization', `Bearer ${token}`);

    console.log(`Status: ${quickBookNoVehicleRes.status}`);
    console.log(`Body: ${JSON.stringify(quickBookNoVehicleRes.body, null, 2)}`);
    if (quickBookNoVehicleRes.status !== 400 || quickBookNoVehicleRes.body.action !== 'SET_VEHICLE') {
      throw new Error('POST /quick-book simulateNoVehicle did not return SET_VEHICLE action');
    }

    // 6. Test POST /api/v1/bookings-simple/quick-book (Successful path)
    console.log('\nTesting POST /api/v1/bookings-simple/quick-book (successful path)...');
    const quickBookRes = await request(app)
      .post('/api/v1/bookings-simple/quick-book')
      .send({ spotId: spot.id })
      .set('Authorization', `Bearer ${token}`);

    console.log(`Status: ${quickBookRes.status}`);
    console.log(`Body: ${JSON.stringify(quickBookRes.body, null, 2)}`);
    if (quickBookRes.status !== 200 || quickBookRes.body.action !== 'CONFIRM_BOOKING') {
      throw new Error('POST /quick-book failed');
    }

    const bookingDetails = quickBookRes.body.details;

    // 7. Test POST /api/v1/bookings-simple/confirm-booking (New endpoint)
    console.log('\nTesting POST /api/v1/bookings-simple/confirm-booking (new endpoint)...');
    const confirmBookingRes = await request(app)
      .post('/api/v1/bookings-simple/confirm-booking')
      .send({ bookingDetails, adjustedDuration: 3 })
      .set('Authorization', `Bearer ${token}`);

    console.log(`Status: ${confirmBookingRes.status}`);
    console.log(`Body: ${JSON.stringify(confirmBookingRes.body, null, 2)}`);
    if (confirmBookingRes.status !== 200 || confirmBookingRes.body.action !== 'SHOW_PAYMENT') {
      throw new Error('POST /confirm-booking failed');
    }

    // Free the spot slots for further testing
    await prisma.parking_spots.update({
      where: { id: spot.id },
      data: { available_slots: 1, car_slots: 1 }
    });

    // 8. Test POST /api/v1/bookings-simple/confirm (Legacy alias)
    console.log('\nTesting POST /api/v1/bookings-simple/confirm (legacy alias compatibility)...');
    const confirmLegacyRes = await request(app)
      .post('/api/v1/bookings-simple/confirm')
      .send({ spotId: spot.id, adjustedDuration: 2 })
      .set('Authorization', `Bearer ${token}`);

    console.log(`Status: ${confirmLegacyRes.status}`);
    console.log(`Body: ${JSON.stringify(confirmLegacyRes.body, null, 2)}`);
    if (confirmLegacyRes.status !== 200 || confirmLegacyRes.body.action !== 'SHOW_PAYMENT') {
      throw new Error('POST /confirm failed');
    }

    console.log('\nAll simplified finder workflow API endpoints are functional!');

    // Cleanup DB records created in this test
    console.log('\nCleaning up database records...');
    await prisma.bookings.deleteMany({ where: { user_id: user.id } });
    await prisma.parking_spots.delete({ where: { id: spot.id } });
    await prisma.users.delete({ where: { id: user.id } });
    await prisma.users.delete({ where: { id: spotter.id } });
    console.log('Cleanup completed.');

  } catch (err) {
    console.error('Test execution failed:', err);
    process.exit(1);
  } finally {
    server.close(() => {
      console.log('Server connection closed.');
      process.exit(0);
    });
  }
}

run();
