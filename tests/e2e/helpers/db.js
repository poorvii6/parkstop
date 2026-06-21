const path = require('path');
process.env.PRISMA_CLIENT_ENGINE_TYPE = 'binary';
require('dotenv').config({ path: path.resolve(__dirname, '../../../backend/.env') });

const prisma = require('../../../backend/src/config/prisma');
const bcrypt = require('../../../backend/node_modules/bcryptjs');

async function resetDB() {
  // Clear all related tables in correct dependency order
  await prisma.bookings.deleteMany();
  await prisma.saved_spots.deleteMany();
  await prisma.payouts.deleteMany();
  await prisma.withdrawals.deleteMany();
  await prisma.payment_methods.deleteMany();
  await prisma.locations.deleteMany();
  await prisma.parking_spots.deleteMany();
  await prisma.users.deleteMany();
}

async function seedDB() {
  const hashedPassword = await bcrypt.hash('password123', 10);

  // 1. Create a Spotter User
  const spotter = await prisma.users.create({
    data: {
      email: 'spotter@example.com',
      password: hashedPassword,
      name: 'John Spotter',
      full_name: 'John Spotter',
      role: 'spotter',
      upi_id: 'spotter@upi',
      balance: 1000.00, // Spotter starts with some balance for withdrawals
      payout_mode: 'upi'
    }
  });

  // 2. Create a Finder User
  const finder = await prisma.users.create({
    data: {
      email: 'finder@example.com',
      password: hashedPassword,
      name: 'Jane Finder',
      full_name: 'Jane Finder',
      role: 'finder',
      balance: 0.00
    }
  });

  // 3. Create a default default payment method for Finder (for Uber-style auto-billing tests)
  const paymentMethod = await prisma.payment_methods.create({
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

  // 4. Create a Parking Spot owned by the Spotter
  const spot = await prisma.parking_spots.create({
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

  return { spotter, finder, paymentMethod, spot };
}

module.exports = {
  prisma,
  resetDB,
  seedDB
};
