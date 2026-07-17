const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function seedBalance() {
  try {
    // Give all users some starting balance for testing production UI
    await prisma.users.updateMany({
      data: {
        balance: 1240.50
      }
    });
    console.log('✅ Successfully seeded balances for all users.');
  } catch (error) {
    console.error('❌ Error seeding balances:', error);
  } finally {
    await prisma.$disconnect();
  }
}

seedBalance();
