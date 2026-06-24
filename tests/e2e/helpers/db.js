const path = require('path');
process.env.PRISMA_CLIENT_ENGINE_TYPE = 'binary';
require('dotenv').config({ path: path.resolve(__dirname, '../../../backend/.env') });

const prisma = require('../../../backend/src/config/prisma');
const bcrypt = require('../../../backend/node_modules/bcryptjs');

async function resetDB() {
  // Clear all related tables in correct dependency order
  // We DO NOT delete main users, payment_methods, or spots because test setups retain JWT tokens.
  // Deleting them changes their auto-increment ID on re-seed, breaking foreign keys.
  await prisma.bookings.deleteMany();
  await prisma.saved_spots.deleteMany();
  await prisma.payouts.deleteMany();
  await prisma.withdrawals.deleteMany();
  await prisma.locations.deleteMany();
  
  // Clean up any dynamically created users by tests
  await prisma.users.deleteMany({
    where: {
      email: { notIn: ['spotter@example.com', 'finder@example.com', 'spotter@parkstop.com', 'finder@parkstop.com', 'finder@test.com', 'spotter@test.com'] }
    }
  });
}

async function seedDB() {
  const hashedPassword = await bcrypt.hash('password123', 10);

  // 1. Upsert Spotter User
  const spotter = await prisma.users.upsert({
    where: { email: 'spotter@example.com' },
    update: { balance: 1000.00, role: 'spotter' },
    create: {
      email: 'spotter@example.com',
      password: hashedPassword,
      name: 'John Spotter',
      full_name: 'John Spotter',
      role: 'spotter',
      upi_id: 'spotter@upi',
      balance: 1000.00,
      payout_mode: 'upi'
    }
  });

  // 2. Upsert Finder User
  const finder = await prisma.users.upsert({
    where: { email: 'finder@example.com' },
    update: { balance: 0.00, role: 'finder' },
    create: {
      email: 'finder@example.com',
      password: hashedPassword,
      name: 'Jane Finder',
      full_name: 'Jane Finder',
      role: 'finder',
      balance: 0.00
    }
  });

  // 2b. Upsert extra debug users
  await prisma.users.upsert({
    where: { email: 'spotter@parkstop.com' },
    update: { balance: 1000.00, role: 'spotter' },
    create: {
      email: 'spotter@parkstop.com',
      password: hashedPassword,
      name: 'Master Spotter',
      full_name: 'Master Spotter',
      role: 'spotter',
      balance: 1000.00,
      upi_id: 'spotter@upi',
      payout_mode: 'upi'
    }
  });

  await prisma.users.upsert({
    where: { email: 'finder@parkstop.com' },
    update: { balance: 100.00, role: 'finder' },
    create: {
      email: 'finder@parkstop.com',
      password: hashedPassword,
      name: 'Master Finder',
      full_name: 'Master Finder',
      role: 'finder',
      balance: 100.00
    }
  });

  await prisma.users.upsert({
    where: { email: 'finder@test.com' },
    update: { role: 'finder' },
    create: {
      email: 'finder@test.com',
      password: hashedPassword,
      name: 'Test Finder',
      full_name: 'Test Finder',
      role: 'finder',
      balance: 0.00
    }
  });

  await prisma.users.upsert({
    where: { email: 'spotter@test.com' },
    update: { role: 'spotter' },
    create: {
      email: 'spotter@test.com',
      password: hashedPassword,
      name: 'Test Spotter',
      full_name: 'Test Spotter',
      role: 'spotter',
      balance: 1000.00
    }
  });

  // 3. Upsert Payment Method
  const pmList = await prisma.payment_methods.findMany({ where: { user_id: finder.id } });
  let paymentMethod = pmList[0];
  if (!paymentMethod) {
    paymentMethod = await prisma.payment_methods.create({
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
  }

  // 4. Upsert Parking Spot
  const spotList = await prisma.parking_spots.findMany({ where: { spotter_id: spotter.id } });
  let spot = spotList[0];
  if (!spot) {
    spot = await prisma.parking_spots.create({
      data: {
        spotter_id: spotter.id,
        title: 'E2E Test Spot',
        description: 'Comfortable E2E spot',
        price_per_hour: 10.00,
        latitude: 12.971598,
        longitude: 77.594562,
        is_available: true,
        address: 'E2E Test Address',
        base_price: 5.00,
        total_slots: 2,
        available_slots: 2,
        location_type: 'urban',
        is_active: true,
        amenities: [],
        slot_names: ['Slot A', 'Slot B']
      }
    });
  } else {
    spot = await prisma.parking_spots.update({
      where: { id: spot.id },
      data: { total_slots: 2, available_slots: 2, car_slots: 2, price_per_hour: 10.00 }
    });
  }

  return { spotter, finder, paymentMethod, spot };
}

module.exports = {
  prisma,
  resetDB,
  seedDB
};
