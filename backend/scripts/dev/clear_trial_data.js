const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Clearing all bookings, saved spots, and parking spots...');
  
  const deletedBookings = await prisma.bookings.deleteMany({});
  console.log(`Deleted ${deletedBookings.count} bookings.`);
  
  const deletedSavedSpots = await prisma.saved_spots.deleteMany({});
  console.log(`Deleted ${deletedSavedSpots.count} saved spots.`);
  
  const deletedSpots = await prisma.parking_spots.deleteMany({});
  console.log(`Deleted ${deletedSpots.count} parking spots.`);
  
  // Find IDs of test/trial users to clear their related records first
  const testUsers = await prisma.users.findMany({
    where: {
      OR: [
        { email: { contains: 'test.com' } },
        { email: { contains: 'trial' } }
      ]
    },
    select: { id: true }
  });
  
  const testUserIds = testUsers.map(u => u.id);
  console.log(`Found ${testUserIds.length} test/trial users to clear.`);
  
  if (testUserIds.length > 0) {
    const deletedLocations = await prisma.locations.deleteMany({
      where: { user_id: { in: testUserIds } }
    });
    console.log(`Deleted ${deletedLocations.count} locations.`);
    
    const deletedPaymentMethods = await prisma.payment_methods.deleteMany({
      where: { user_id: { in: testUserIds } }
    });
    console.log(`Deleted ${deletedPaymentMethods.count} payment methods.`);
    
    const deletedWithdrawals = await prisma.withdrawals.deleteMany({
      where: { user_id: { in: testUserIds } }
    });
    console.log(`Deleted ${deletedWithdrawals.count} withdrawals.`);
    
    const deletedTestUsers = await prisma.users.deleteMany({
      where: { id: { in: testUserIds } }
    });
    console.log(`Deleted ${deletedTestUsers.count} users.`);
  }
  
  console.log('Cleanup completed successfully!');
}

main()
  .catch(e => {
    console.error('Error clearing database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
