// Force the binary engine to bypass experimental Node.js detection issues
process.env.PRISMA_CLIENT_ENGINE_TYPE = 'binary';

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  log: ['warn', 'error'],
});

module.exports = prisma;
