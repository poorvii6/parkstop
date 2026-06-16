const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const result = await prisma.parking_spots.updateMany({
    data: {
      car_slots: 10,
      available_slots: 10,
      is_available: true,
      is_active: true
    }
  });
  console.log(`Reset ${result.count} parking spots.`);
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
