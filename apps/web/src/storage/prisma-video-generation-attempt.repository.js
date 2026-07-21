const crypto = require('node:crypto');
const { Prisma } = require('../../dist/generated/prisma/client.js');
const { json } = require('./prisma-shared');
const { ACTIVE_STATES, RECOVERABLE_STATES } = require('./video-generation-attempt-store');

function date(value) { return value ? new Date(value) : null; }

class PrismaVideoGenerationAttemptRepository {
  constructor(prisma) { this.prisma = prisma; }
  create(data) {
    return this.prisma.videoGenerationAttempt.create({ data: {
      id: crypto.randomUUID(), generationJobId: data.generationJobId || null, generationRequestId: data.generationRequestId || null,
      tenantId: data.tenantId || null, userId: data.userId || null, projectId: data.projectId || null, sceneId: data.sceneId || null,
      provider: data.provider, model: data.model, generationMode: data.generationMode,
      requestSnapshot: json(data.requestSnapshot), requestFingerprint: data.requestFingerprint || null,
      inputHashes: json(data.inputHashes) || [], lifecycleState: data.lifecycleState,
      providerTaskId: data.providerTaskId || null, pollAfter: date(data.pollAfter), retryCount: data.retryCount || 0,
      providerSubmittedAt: date(data.providerSubmittedAt),
      cancellationState: data.cancellationState || 'not_requested', providerOutputId: data.providerOutputId || null,
      outputExpiresAt: date(data.outputExpiresAt), downloadState: data.downloadState || 'pending', commitState: data.commitState || 'pending',
      costReferences: json(data.costReferences), error: json(data.error), completedAt: date(data.completedAt),
    } });
  }
  async createActive(data) {
    try { return { attempt: await this.create(data), created: true }; }
    catch (cause) {
      if (!(cause instanceof Prisma.PrismaClientKnownRequestError) || cause.code !== 'P2002') throw cause;
      const attempt = await this.findActive(data);
      if (!attempt) throw cause;
      return { attempt, created: false };
    }
  }
  get(id) { return this.prisma.videoGenerationAttempt.findUnique({ where: { id } }); }
  update(id, patch) {
    const allowed = ['generationRequestId', 'providerTaskId', 'providerSubmittedAt', 'lifecycleState', 'pollAfter', 'retryCount', 'cancellationState', 'providerOutputId', 'outputExpiresAt', 'downloadState', 'commitState', 'costReferences', 'error', 'completedAt'];
    const data = {};
    for (const key of allowed) if (Object.hasOwn(patch, key)) data[key] = ['providerSubmittedAt', 'pollAfter', 'outputExpiresAt', 'completedAt'].includes(key) ? date(patch[key]) : ['costReferences', 'error'].includes(key) ? json(patch[key]) : patch[key];
    return this.prisma.videoGenerationAttempt.update({ where: { id }, data });
  }
  listRecoverable(now = new Date()) {
    return this.prisma.videoGenerationAttempt.findMany({ where: { lifecycleState: { in: [...RECOVERABLE_STATES] }, OR: [{ pollAfter: null }, { pollAfter: { lte: now } }] }, orderBy: { createdAt: 'asc' } });
  }
  keyWhere(query = {}) {
    return Object.fromEntries(['tenantId', 'projectId', 'sceneId', 'provider']
      .filter((key) => Object.hasOwn(query, key)).map((key) => [key, query[key] || null]));
  }
  findActive(query) {
    return this.prisma.videoGenerationAttempt.findFirst({
      where: { ...this.keyWhere(query), lifecycleState: { in: [...ACTIVE_STATES] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }
  listActive(query = {}) {
    return this.prisma.videoGenerationAttempt.findMany({
      where: { ...this.keyWhere(query), lifecycleState: { in: [...ACTIVE_STATES] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }
  findCommittedAfter(query, createdAt) {
    return this.prisma.videoGenerationAttempt.findFirst({
      where: { ...this.keyWhere(query), lifecycleState: 'committed', completedAt: { gte: new Date(createdAt) } },
      orderBy: { completedAt: 'desc' },
    });
  }
}

module.exports = { PrismaVideoGenerationAttemptRepository };
