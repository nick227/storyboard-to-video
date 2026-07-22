const crypto = require('node:crypto');
const { Prisma } = require('../../dist/generated/prisma/client.js');
const { AppError } = require('../errors');

function json(value) { return value == null ? undefined : JSON.parse(JSON.stringify(value)); }

class PrismaUsageRepository {
  constructor(prisma) { this.prisma = prisma; }

  async begin(trace, metadata) {
    try {
      const request = await this.prisma.generationRequest.create({ data: {
        id: crypto.randomUUID(), tenantId: trace.tenantId, userId: trace.userId || null,
        projectId: trace.projectId || null, sceneId: trace.sceneId || null, jobId: trace.jobId || null,
        idempotencyKey: trace.idempotencyKey || null, sequence: metadata.sequence,
        modality: metadata.modality, provider: metadata.provider, model: metadata.model,
        status: 'started', inputMetadata: json(metadata.inputMetadata),
      } });
      return request;
    } catch (cause) {
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2002') {
        throw new AppError('DUPLICATE_PROVIDER_REQUEST', 'This job provider request was already recorded', { status: 409, cause });
      }
      throw cause;
    }
  }

  getRequest(id) { return this.prisma.generationRequest.findUnique({ where: { id } }); }

  async complete(request, result, outputMetadata) {
    return this.prisma.$transaction(async (db) => {
      const settled = await db.generationRequest.updateMany({
        where: { id: request.id, status: 'started' },
        data: { status: 'completed', providerRequestId: result.providerRequestId || null, outputMetadata: json(outputMetadata), completedAt: new Date() },
      });
      if (!settled.count) return db.usageEvent.findUnique({ where: { generationRequestId: request.id } });
      return db.usageEvent.create({ data: {
        id: crypto.randomUUID(), generationRequestId: request.id, tenantId: request.tenantId,
        userId: request.userId, projectId: request.projectId, sceneId: request.sceneId, jobId: request.jobId,
        // Pricing/spend always match on the canonical configured provider+modality+model key, so
        // UsageEvent.model must equal GenerationRequest.model here -- never result.model, which
        // can be a dated/versioned string a provider's own API response returns (e.g. OpenAI
        // returning "gpt-4.1-mini-2025-04-14" for a request tracked as "gpt-4.1-mini"). That raw
        // value is preserved separately for audit/debugging.
        modality: request.modality, provider: request.provider, model: request.model,
        providerModel: result.model && result.model !== request.model ? result.model : null,
        providerRequestId: result.providerRequestId || null, usage: json(result.usage) || {},
        ...(result.rawUsage == null ? {} : { rawUsage: json(result.rawUsage) }), measurementStatus: result.measurementStatus,
      } });
    });
  }

  async fail(request, error) {
    await this.prisma.generationRequest.updateMany({
      where: { id: request.id, status: 'started' },
      data: { status: 'failed', error: { code: error.code || 'PROVIDER_FAILED', message: String(error.message || 'Provider request failed').slice(0, 1000) }, completedAt: new Date() },
    });
  }

  async list({ tenantId, limit = 100 } = {}) {
    return this.prisma.usageEvent.findMany({
      where: tenantId ? { tenantId } : {}, include: { generationRequest: true },
      orderBy: { occurredAt: 'desc' }, take: Math.min(500, Math.max(1, Number(limit) || 100)),
    });
  }
}

module.exports = { PrismaUsageRepository };
