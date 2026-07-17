const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Searching for a spotter...');
  const spotter = await prisma.users.findFirst({
    where: { role: 'spotter' }
  });

  if (!spotter) {
    console.log('No spotter found. Creating a test spotter...');
    const newSpotter = await prisma.users.create({
      data: {
        name: 'Test Spotter',
        email: 'spotter@test.com',
        phone: '9876543210',
        password_hash: 'hashed', // Not used for trials
        role: 'spotter'
      }
    });
    return seedSpots(newSpotter.id);
  }

  console.log(`Found spotter: ${spotter.name} (ID: ${spotter.id})`);
  await seedSpots(spotter.id);
}

async function seedSpots(spotterId) {
  const spots = [
    {
      title: 'Hitech City Plaza Parking',
      latitude: 17.4483,
      longitude: 78.3915,
      price_per_hour: 40,
      total_slots: 10,
      available_slots: 10,
      is_available: true,
      location_type: 'urban'
    },
    {
      title: 'Indiranagar Metro Side',
      latitude: 12.9784,
      longitude: 77.6408,
      price_per_hour: 50,
      total_slots: 5,
      available_slots: 5,
      is_available: true,
      location_type: 'urban'
    },
    {
      title: 'Connaught Place Block A',
      latitude: 28.6328,
      longitude: 77.2197,
      price_per_hour: 60,
      total_slots: 15,
      available_slots: 15,
      is_available: true,
      location_type: 'urban'
    },
    {
      title: 'Gateway of India Front',
      latitude: 18.9220,
      longitude: 72.8347,
      price_per_hour: 80,
      total_slots: 8,
      available_slots: 8,
      is_available: true,
      location_type: 'urban'
    }
  ];

  console.log('Seeding spots...');
  for (const spot of spots) {
    await prisma.parking_spots.create({
      data: {
        ...spot,
        spotter_id: spotterId,
        is_active: true
      }
    });
    console.log(`Created spot: ${spot.title}`);
  }
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
