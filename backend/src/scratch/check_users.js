const prisma = require('../config/prisma');

async function check() {
  try {
    const users = await prisma.users.findMany({
      select: {
        id: true,
        email: true,
        full_name: true,
        role: true,
        upi_id: true,
        bank_account_number: true,
        payout_mode: true,
        balance: true
      }
    });
    console.log('--- USERS IN DATABASE ---');
    console.log(JSON.stringify(users, null, 2));
    console.log('-------------------------');
  } catch (error) {
    console.error('Error querying users:', error);
  } finally {
    await prisma.$disconnect();
  }
}

check();
