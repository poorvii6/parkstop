const prisma = require('../src/config/prisma');
const bcrypt = require('bcryptjs');

async function main() {
  console.log('🌱 Seeding test data...');

  // 1. Create a Test Spotter
  const hashedUserPassword = await bcrypt.hash('password123', 10);
  const spotter = await prisma.users.upsert({
    where: { email: 'spotter@test.com' },
    update: {},
    create: {
      email: 'spotter@test.com',
      password: hashedUserPassword,
      name: 'Test Spotter',
      full_name: 'Test Spotter',
      phone: '9876543210',
      role: 'spotter'
    }
  });
  console.log('✅ Created Spotter:', spotter.email);

  // 2. Create a Test Finder
  const finder = await prisma.users.upsert({
    where: { email: 'finder@test.com' },
    update: {},
    create: {
      email: 'finder@test.com',
      password: hashedUserPassword,
      name: 'Test Finder',
      full_name: 'Test Finder',
      phone: '1234567890',
      role: 'finder'
    }
  });
  console.log('✅ Created Finder:', finder.email);

  // 3. Create some Parking Spots
  const spotsData = [
    {
      title: 'Downtown Secure Parking',
      description: 'Gated parking with 24/7 security',
      price_per_hour: 5.50,
      latitude: 12.9716,
      longitude: 77.5946,
      address: 'MG Road, Bangalore',
      location_type: 'urban',
      total_slots: 5,
      available_slots: 5,
      spotter_id: spotter.id
    },
    {
      title: 'Suburban Driveway',
      description: 'Quiet driveway in a safe neighborhood',
      price_per_hour: 2.00,
      latitude: 12.9279,
      longitude: 77.6271,
      address: 'Koramangala, Bangalore',
      location_type: 'residential',
      total_slots: 1,
      available_slots: 1,
      spotter_id: spotter.id
    }
  ];

  for (const spot of spotsData) {
    await prisma.parking_spots.create({ data: spot });
  }
  console.log('✅ Created Parking Spots');

  console.log('✨ Seeding complete!');
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
