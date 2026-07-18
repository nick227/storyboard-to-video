const crypto = require('node:crypto');

// Production-mode equivalent of generation-cache-store.js — same append-only-per-(tenantId,
// fingerprintHash) contract, backed by the GenerationCacheEntry table instead of the filesystem.
class PrismaGenerationCacheRepository {
  constructor(prisma) {
    this.prisma = prisma;
  }

  async lookup(tenantId, fingerprintHash) {
    return this.prisma.generationCacheEntry.findFirst({
      where: { tenantId, fingerprintHash },
      orderBy: { createdAt: 'desc' },
    });
  }

  async store(entry) {
    return this.prisma.generationCacheEntry.create({
      data: { id: crypto.randomUUID(), ...entry },
    });
  }
}

module.exports = { PrismaGenerationCacheRepository };
