const crypto = require('node:crypto');
const { json } = require('./prisma-shared');
const { RECOVERABLE_STATES } = require('./video-generation-attempt-store');

function date(value) { return value ? new Date(value) : null; }

class PrismaVideoGenerationAttemptRepository {
  constructor(prisma) { this.prisma = prisma; }
  create(data) {
    return this.prisma.videoGenerationAttempt.create({ data: {
      id: crypto.randomUUID(), generationJobId: data.generationJobId || null, generationRequestId: data.generationRequestId || null,
      tenantId: data.tenantId || null, userId: data.userId || null, projectId: data.projectId || null, sceneId: data.sceneId || null,
      provider: data.provider, model: data.model, generationMode: data.generationMode,
      requestSnapshot: json(data.requestSnapshot), inputHashes: json(data.inputHashes) || [], lifecycleState: data.lifecycleState,
      providerTaskId: data.providerTaskId || null, pollAfter: date(data.pollAfter), retryCount: data.retryCount || 0,
      cancellationState: data.cancellationState || 'not_requested', providerOutputId: data.providerOutputId || null,
      outputExpiresAt: date(data.outputExpiresAt), downloadState: data.downloadState || 'pending', commitState: data.commitState || 'pending',
      costReferences: json(data.costReferences), error: json(data.error), completedAt: date(data.completedAt),
    } });
  }
  get(id) { return this.prisma.videoGenerationAttempt.findUnique({ where: { id } }); }
  update(id, patch) {
    const allowed = ['generationRequestId', 'providerTaskId', 'lifecycleState', 'pollAfter', 'retryCount', 'cancellationState', 'providerOutputId', 'outputExpiresAt', 'downloadState', 'commitState', 'costReferences', 'error', 'completedAt'];
    const data = {};
    for (const key of allowed) if (Object.hasOwn(patch, key)) data[key] = ['pollAfter', 'outputExpiresAt', 'completedAt'].includes(key) ? date(patch[key]) : ['costReferences', 'error'].includes(key) ? json(patch[key]) : patch[key];
    return this.prisma.videoGenerationAttempt.update({ where: { id }, data });
  }
  listRecoverable(now = new Date()) {
    return this.prisma.videoGenerationAttempt.findMany({ where: { lifecycleState: { in: [...RECOVERABLE_STATES] }, OR: [{ pollAfter: null }, { pollAfter: { lte: now } }] }, orderBy: { createdAt: 'asc' } });
  }
}

module.exports = { PrismaVideoGenerationAttemptRepository };
