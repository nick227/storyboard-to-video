require('dotenv').config();

const { loadConfig } = require('../src/config/env');
const { createPrismaClient } = require('../src/storage/prisma-client');

// One-time backfill for UsageEvent rows written before prisma-usage.repository.js started storing
// the canonical GenerationRequest.model on UsageEvent.model (instead of the provider's raw
// returned model string). Idempotent: only touches rows that still disagree with their linked
// GenerationRequest, and never overwrites an already-set providerModel.
async function main() {
  const config = loadConfig();
  const prisma = createPrismaClient(config.env.DATABASE_URL);
  try {
    const events = await prisma.usageEvent.findMany({ select: { id: true, model: true, providerModel: true, generationRequestId: true } });
    const requests = await prisma.generationRequest.findMany({ select: { id: true, model: true } });
    const canonicalModelById = new Map(requests.map((r) => [r.id, r.model]));

    let updated = 0;
    for (const event of events) {
      const canonical = canonicalModelById.get(event.generationRequestId);
      if (!canonical || canonical === event.model) continue;
      await prisma.usageEvent.update({
        where: { id: event.id },
        data: { model: canonical, providerModel: event.providerModel || event.model },
      });
      console.log(`normalized ${event.id}: model '${event.model}' -> '${canonical}' (providerModel preserved: '${event.providerModel || event.model}')`);
      updated += 1;
    }
    console.log(`done. ${updated} row(s) normalized out of ${events.length} total usage events.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
