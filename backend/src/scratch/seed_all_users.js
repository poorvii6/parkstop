const prisma = require('../config/prisma');
const bcrypt = require('bcryptjs');

async function seed() {
  try {
    const hashedPassword = await bcrypt.hash('password123', 10);

    const usersToSeed = [
      {
        email: 'finder@example.com',
        name: 'Jane Finder',
        role: 'finder',
        balance: 0.00
      },
      {
        email: 'spotter@example.com',
        name: 'John Spotter',
        role: 'spotter',
        balance: 1000.00,
        upi_id: 'spotter@upi',
        payout_mode: 'upi'
      },
      {
        email: 'spotter@parkstop.com',
        name: 'Master Spotter',
        role: 'spotter',
        balance: 1000.00,
        upi_id: 'spotter@upi',
        payout_mode: 'upi'
      },
      {
        email: 'finder@parkstop.com',
        name: 'Master Finder',
        role: 'finder',
        balance: 100.00
      },
      {
        email: 'finder@test.com',
        name: 'Test Finder',
        role: 'finder',
        balance: 0.00
      },
      {
        email: 'spotter@test.com',
        name: 'Test Spotter',
        role: 'spotter',
        balance: 1000.00
      }
    ];

    console.log('🌱 Seeding all debug accounts into the database...');
    for (const u of usersToSeed) {
      const created = await prisma.users.upsert({
        where: { email: u.email },
        update: {
          password: hashedPassword,
          role: u.role,
          full_name: u.name,
          name: u.name,
          balance: u.balance,
          upi_id: u.upi_id || null,
          payout_mode: u.payout_mode || 'upi'
        },
        create: {
          email: u.email,
          password: hashedPassword,
          full_name: u.name,
          name: u.name,
          role: u.role,
          balance: u.balance,
          upi_id: u.upi_id || null,
          payout_mode: u.payout_mode || 'upi'
        }
      });
      console.log(`✅ Upserted ${created.role} user: ${created.email}`);
    }

    // Also let's check parking spots
    const spotter = await prisma.users.findFirst({ where: { role: 'spotter' } });
    if (spotter) {
      const existingSpot = await prisma.parking_spots.findFirst();
      if (!existingSpot) {
        await prisma.parking_spots.create({
          data: {
            spotter_id: spotter.id,
            title: 'Downtown Secure Parking',
            description: 'Gated parking with 24/7 security',
            price_per_hour: 5.50,
            latitude: 12.9716,
            longitude: 77.5946,
            address: 'MG Road, Bangalore',
            location_type: 'urban',
            total_slots: 5,
            available_slots: 5,
            is_available: true,
            is_active: true,
            slot_names: ['Slot A', 'Slot B', 'Slot C', 'Slot D', 'Slot E']
          }
        });
        console.log('✅ Created a default parking spot for Bangalore');
      }
    }

    console.log('✨ All debug accounts seeded successfully!');
  } catch (error) {
    console.error('❌ Seeding failed:', error);
  } finally {
    await prisma.$disconnect();
  }
}

seed();
