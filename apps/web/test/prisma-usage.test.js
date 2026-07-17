const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createPrismaClient } = require('../src/storage/prisma-client');
const { PrismaIdentityRepository } = require('../src/storage/prisma-identity.repository');
const { PrismaUsageRepository } = require('../src/storage/prisma-usage.repository');
const { createProviderUsageService } = require('../src/services/provider-usage.service');
const { providerResult } = require('../src/providers/result');

const enabled = process.env.PRISMA_INTEGRATION_TESTS === '1';

test('usage tracking persists before execution and settles one immutable event per provider request', { skip: !enabled }, async () => {
  const prisma = createPrismaClient(process.env.DATABASE_URL);
  const identity = new PrismaIdentityRepository(prisma);
  let userId; let tenantId;
  try {
    const clockBefore = Date.now();
    const [databaseClock] = await prisma.$queryRawUnsafe('SELECT CURRENT_TIMESTAMP AS now');
    const clockAfter = Date.now();
    assert.ok(databaseClock.now.getTime() >= clockBefore && databaseClock.now.getTime() <= clockAfter, 'Prisma and PostgreSQL clocks must represent the same UTC instant');

    const account = await identity.createUserWithPersonalWorkspace({ email: `usage-${crypto.randomUUID()}@example.com`, displayName: 'Usage Test', passwordHash: 'test-only' });
    userId = account.user.id; tenantId = account.tenant.id;
    const repository = new PrismaUsageRepository(prisma);
    const context = new AsyncLocalStorage();
    const tracker = createProviderUsageService({ repository, generationContext: context });
    const jobId = crypto.randomUUID();
    const trace = { tenantId, userId, projectId: 'historical-project', sceneId: 'scene-1', jobId, idempotencyKey: 'usage-request-001' };
    const result = await context.run({ trace, providerSequence: 0 }, () => tracker.execute({ modality: 'text', provider: 'openai', model: 'test-model', inputMetadata: { promptCharacters: 12 } }, async () => {
      const started = await prisma.generationRequest.findUnique({ where: { jobId_sequence: { jobId, sequence: 1 } } });
      assert.equal(started.status, 'started');
      return providerResult({ output: 'done', provider: 'openai', model: 'test-model', providerRequestId: 'provider-123', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 }, rawUsage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 }, measurementStatus: 'observed' });
    }));
    assert.equal(result.output, 'done');
    const request = await prisma.generationRequest.findUnique({ where: { jobId_sequence: { jobId, sequence: 1 } } });
    const event = await prisma.usageEvent.findUnique({ where: { generationRequestId: request.id } });
    assert.equal(request.status, 'completed');
    assert.equal(event.tenantId, tenantId);
    assert.equal(event.userId, userId);
    assert.equal(event.projectId, 'historical-project');
    assert.equal(event.sceneId, 'scene-1');
    assert.equal(event.jobId, jobId);
    assert.equal(event.providerRequestId, 'provider-123');
    assert.deepEqual(event.usage, { inputTokens: 3, outputTokens: 1, totalTokens: 4 });

    await repository.complete(request, result, { kind: 'text', characters: 4 });
    assert.equal(await prisma.usageEvent.count({ where: { generationRequestId: request.id } }), 1);

    let duplicateExecuted = false;
    await assert.rejects(
      context.run({ trace, providerSequence: 0 }, () => tracker.execute({ modality: 'text', provider: 'openai', model: 'test-model' }, async () => { duplicateExecuted = true; return result; })),
      (error) => error.code === 'DUPLICATE_PROVIDER_REQUEST',
    );
    assert.equal(duplicateExecuted, false);

    const failedJobId = crypto.randomUUID();
    await assert.rejects(
      context.run({ trace: { ...trace, jobId: failedJobId }, providerSequence: 0 }, () => tracker.execute({ modality: 'image', provider: 'openai', model: 'test-image-model' }, async () => { throw new Error('provider unavailable'); })),
      /provider unavailable/,
    );
    const failed = await prisma.generationRequest.findUnique({ where: { jobId_sequence: { jobId: failedJobId, sequence: 1 } } });
    assert.equal(failed.status, 'failed');
    assert.equal(await prisma.usageEvent.count({ where: { generationRequestId: failed.id } }), 0);
  } finally {
    if (tenantId) await prisma.workspace.deleteMany({ where: { id: tenantId } });
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  }
});
