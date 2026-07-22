const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createPrismaClient } = require('../src/storage/prisma-client');
const { PrismaIdentityRepository } = require('../src/storage/prisma-identity.repository');
const { PrismaUsageRepository } = require('../src/storage/prisma-usage.repository');
const { createProviderUsageService } = require('../src/services/provider-usage.service');
const { createAlignmentProvider } = require('../src/providers/alignment');
const { createVoiceService } = require('../src/services/voice.service');
const { createAudioProviders } = require('../src/providers/audio');

const enabled = process.env.PRISMA_INTEGRATION_TESTS === '1';

test('alignment and voice preview/clone/reference/preflight calls create real usage events (previously entirely untracked)', { skip: !enabled }, async () => {
  const prisma = createPrismaClient(process.env.DATABASE_URL);
  const identity = new PrismaIdentityRepository(prisma);
  const usageRepository = new PrismaUsageRepository(prisma);
  const account = await identity.createUserWithPersonalWorkspace({ email: `usage-coverage-${crypto.randomUUID()}@example.com`, displayName: 'Usage Coverage Test', passwordHash: 'test-only' });
  const generationContext = new AsyncLocalStorage();
  const usageTracker = createProviderUsageService({ repository: usageRepository, generationContext });
  const config = {
    env: {}, paths: { piperVoices: '/tmp', piper: '/tmp/piper' }, piperVoices: ['en_US-lessac-medium'],
    sparkUrl: 'http://spark.test', sparkTimeout: 1000, sparkServiceToken: '',
    piperUrl: 'http://piper.test',
    alignUrl: 'http://align.test', alignTimeout: 1000,
  };
  const originalFetch = global.fetch;
  const run = (operation) => {
    const jobId = crypto.randomUUID();
    const trace = { tenantId: account.tenant.id, userId: account.user.id, projectId: 'usage-coverage-test', jobId, idempotencyKey: `usage-coverage:${jobId}` };
    return generationContext.run({ trace, providerSequence: 0, signal: new AbortController().signal }, operation);
  };
  try {
    global.fetch = async (url) => {
      const value = String(url);
      if (value.includes('align.test')) return new Response(JSON.stringify({ words: [{ text: 'hi', start: 0, end: 0.3, score: 0.9 }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (value.includes('piper.test') && value.includes('/preview')) return new Response(Buffer.from([0, 0, 0, 0]), { status: 200 });
      if (value.includes('spark.test') && value.includes('/health')) return new Response('', { status: 200 });
      if (value.includes('spark.test') && value.includes('/reference')) return new Response(Buffer.from([0, 0, 0, 0]), { status: 200, headers: { 'Content-Type': 'audio/wav' } });
      if (value.includes('spark.test') && value.includes('/voices')) return new Response(JSON.stringify({ voiceId: 'cloned-1', name: 'Cloned Voice' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      throw new Error(`Unexpected URL: ${value}`);
    };

    const alignment = createAlignmentProvider(config, () => null, usageTracker);
    await run(() => alignment.align({ audioBuffer: Buffer.from('audio'), transcript: 'Hi there', mimeType: 'audio/wav' }));

    const audioProviders = createAudioProviders(config, () => null, usageTracker);
    const voices = createVoiceService(config, () => null, audioProviders, usageTracker);
    await run(() => voices.piperPreview('en_US-lessac-medium'));
    await run(() => voices.clone({ buffer: Buffer.from('audio'), originalname: 'clip.webm' }, 'My Clone'));
    await run(() => voices.reference('cloned-1'));
    await run(() => voices.sparkPreflight());

    const requests = await prisma.generationRequest.findMany({ where: { tenantId: account.tenant.id }, include: { usageEvent: true } });
    const byModel = new Map(requests.map((r) => [`${r.provider}/${r.modality}/${r.model}`, r]));

    for (const key of ['whisperx/alignment/whisperx-forced-alignment', 'piper/audio/piper-modal', 'spark/audio/spark-voice-clone', 'spark/audio/spark-reference', 'spark/audio/spark-preflight']) {
      const request = byModel.get(key);
      assert.ok(request, `expected a GenerationRequest for ${key}`);
      assert.ok(request.usageEvent, `expected a UsageEvent for ${key}`);
      assert.equal(request.status, 'completed');
    }
  } finally {
    global.fetch = originalFetch;
    await prisma.$disconnect();
  }
});
