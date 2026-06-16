const prisma = require('../src/config/prisma');
const logger = require('../src/utils/logger');

async function runTest() {
  console.log('🚀 Starting Prisma Connection Test...');
  
  try {
    // 1. Test User Find
    console.log('--- Testing Users ---');
    const userCount = await prisma.users.count();
    console.log(`✅ Total Users in DB: ${userCount}`);

    // 2. Test Parking Spot Find
    console.log('\n--- Testing Parking Spots ---');
    const spotCount = await prisma.parking_spots.count();
    console.log(`✅ Total Parking Spots in DB: ${spotCount}`);

    // 3. Test Booking Find
    console.log('\n--- Testing Bookings ---');
    const bookingCount = await prisma.bookings.count();
    console.log(`✅ Total Bookings in DB: ${bookingCount}`);

    // 4. Test Location Service (The new one we added)
    console.log('\n--- Testing Location Service ---');
    if (userCount > 0) {
      const firstUser = await prisma.users.findFirst();
      const Location = require('../src/models/Location');
      
      console.log(`Updating location for user: ${firstUser.email}`);
      await Location.createOrUpdate({
        user_id: firstUser.id,
        latitude: 12.9716,
        longitude: 77.5946
      });
      
      const loc = await Location.findByUser(firstUser.id);
      console.log('✅ Last Known Location:', loc);
    } else {
      console.log('⚠️ No users found to test location update.');
    }

    console.log('\n✨ ALL TESTS PASSED SUCCESSFULLY! ✨');

  } catch (error) {
    console.error('\n❌ TEST FAILED:');
    console.error(error);
  } finally {
    await prisma.$disconnect();
  }
}

runTest();
