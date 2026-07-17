const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('../../dist/generated/prisma/client.js');

function createPrismaClient(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  // The pg driver adapter treats PostgreSQL timestamp values as UTC when it
  // converts them to JavaScript Date objects. Keep every Prisma session in UTC
  // so TIMESTAMPTZ defaults and supplied Date values represent the same instant.
  return new PrismaClient({ adapter: new PrismaPg({ connectionString, options: '-c timezone=UTC' }) });
}

module.exports = { createPrismaClient };
