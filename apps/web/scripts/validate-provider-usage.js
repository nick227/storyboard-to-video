require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { loadConfig } = require('../src/config/env');
const { createPrismaClient } = require('../src/storage/prisma-client');
const { PrismaIdentityRepository } = require('../src/storage/prisma-identity.repository');
const { PrismaUsageRepository } = require('../src/storage/prisma-usage.repository');
const { createProviderUsageService } = require('../src/services/provider-usage.service');
const { createTextProviders } = require('../src/providers/text');
const { createImageProviders } = require('../src/providers/image');

function summarizeResult(result) {
  const output = result?.output;
  return {
    provider: result?.provider,
    model: result?.model,
    providerRequestId: result?.providerRequestId,
    measurementStatus: result?.measurementStatus,
    usage: result?.usage,
    rawUsage: result?.rawUsage,
    output: Buffer.isBuffer(output?.buffer)
      ? { bytes: output.buffer.length, mimeType: output.mimeType, extension: output.extension }
      : { characters: String(output || '').length },
  };
}

async function main() {
  const config = loadConfig();
  if (!config.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const prisma = createPrismaClient(config.env.DATABASE_URL);
  const identity = new PrismaIdentityRepository(prisma);
  const generationContext = new AsyncLocalStorage();
  const repository = new PrismaUsageRepository(prisma);
  const tracker = createProviderUsageService({ repository, generationContext });
  const cancellation = () => generationContext.getStore()?.signal;
  const text = createTextProviders(config, cancellation, tracker);
  const images = createImageProviders(config, text, cancellation, tracker);
  const account = await identity.ensureLegacyIdentity('provider-validation');
  const validationId = `provider-validation-${new Date().toISOString().slice(0, 10)}`;
  const report = {
    createdAt: new Date().toISOString(),
    validationId,
    officialPricingSources: {
      openai: 'https://developers.openai.com/api/docs/pricing',
      openaiImages: 'https://developers.openai.com/api/docs/guides/image-generation#calculating-costs',
      gemini: 'https://ai.google.dev/gemini-api/docs/pricing',
      dezgo: 'https://dev.dezgo.com/pricing/sd1/',
    },
    cases: [],
    skipped: [],
    dashboardComparison: 'manual_required',
  };

  async function runCase(name, operation, { jobId = crypto.randomUUID(), expectedFailure = false } = {}) {
    const trace = { tenantId: account.tenant.id, userId: account.user.id, projectId: validationId, jobId, idempotencyKey: `validation:${name}` };
    let result; let error;
    try { result = await generationContext.run({ trace, providerSequence: 0, signal: new AbortController().signal }, operation); }
    catch (cause) { error = { code: cause.code || 'ERROR', message: cause.message }; }
    const request = await prisma.generationRequest.findFirst({ where: { jobId }, include: { usageEvent: true }, orderBy: { sequence: 'desc' } });
    report.cases.push({ name, jobId, expectedFailure, result: result ? summarizeResult(result) : null, error, storedRequest: request && { id: request.id, status: request.status, provider: request.provider, model: request.model, providerRequestId: request.providerRequestId, usageEvent: request.usageEvent && { id: request.usageEvent.id, usage: request.usageEvent.usage, rawUsage: request.usageEvent.rawUsage, measurementStatus: request.usageEvent.measurementStatus } } });
    if (expectedFailure ? !error || request?.status !== 'failed' || request?.usageEvent : error || request?.status !== 'completed' || !request?.usageEvent) throw new Error(`Validation case failed its accounting invariant: ${name}`);
    return { result, jobId };
  }

  try {
    let openAiText;
    if (config.env.OPENAI_API_KEY) openAiText = await runCase('openai-text', () => text.call('openai', 'Reply with exactly: VALIDATED'));
    else report.skipped.push({ case: 'openai-text', reason: 'OPENAI_API_KEY missing' });
    if (config.env.GEMINI_API_KEY) await runCase('gemini-text', () => text.call('gemini', 'Reply with JSON only: {"status":"VALIDATED"}'));
    else report.skipped.push({ case: 'gemini-text', reason: 'GEMINI_API_KEY missing' });
    if (config.env.OPENAI_API_KEY) await runCase('openai-image', () => images.generate({ provider: 'openai', prompt: 'A simple black circle centered on a plain white background.', references: [], title: 'Validation' }));
    else report.skipped.push({ case: 'openai-image', reason: 'OPENAI_API_KEY missing' });
    if (config.env.GEMINI_API_KEY) await runCase('gemini-image', () => images.generate({ provider: 'gemini', prompt: 'A simple black circle centered on a plain white background.', references: [], title: 'Validation' }));
    else report.skipped.push({ case: 'gemini-image', reason: 'GEMINI_API_KEY missing' });
    if (config.env.DEZGO_API_KEY) await runCase('dezgo-image', () => images.generate({ provider: 'dezgo', prompt: 'A simple black circle centered on a plain white background.', references: [], title: 'Validation' }));
    else report.skipped.push({ case: 'dezgo-image', reason: 'DEZGO_API_KEY missing' });
    if (!config.env.ELEVENLABS_API_KEY) report.skipped.push({ case: 'elevenlabs-audio', reason: 'ELEVENLABS_API_KEY missing' });
    if (!config.env.LTX_VIDEO_API_TOKEN) report.skipped.push({ case: 'paid-video', reason: 'No paid video provider credential configured; LTX is local' });

    if (config.env.OPENAI_API_KEY) {
      const invalidConfig = { ...config, env: { ...config.env, OPENAI_TEXT_MODEL: `invalid-validation-model-${crypto.randomUUID()}` } };
      const invalidText = createTextProviders(invalidConfig, cancellation, tracker);
      await runCase('failed-provider-request', () => invalidText.call('openai', 'This request should fail before inference.'), { expectedFailure: true });
    }

    if (openAiText) {
      let replayExecuted = false;
      const trace = { tenantId: account.tenant.id, userId: account.user.id, projectId: validationId, jobId: openAiText.jobId, idempotencyKey: 'validation:openai-text' };
      let replayError;
      try {
        await generationContext.run({ trace, providerSequence: 0, signal: new AbortController().signal }, () => tracker.execute({ modality: 'text', provider: 'openai', model: config.env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini' }, async () => { replayExecuted = true; return openAiText.result; }));
      } catch (error) { replayError = error.code; }
      const eventCount = await prisma.usageEvent.count({ where: { jobId: openAiText.jobId } });
      report.cases.push({ name: 'idempotent-replay', jobId: openAiText.jobId, replayExecuted, replayError, eventCount });
      if (replayExecuted || replayError !== 'DUPLICATE_PROVIDER_REQUEST' || eventCount !== 1) throw new Error('Idempotent replay accounting invariant failed');
    }

    const directory = path.join(config.paths.root, 'data', 'provider-validation');
    fs.mkdirSync(directory, { recursive: true });
    const reportPath = path.join(directory, `${Date.now()}.json`);
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ ok: true, reportPath, cases: report.cases.map((item) => ({ name: item.name, status: item.storedRequest?.status || (item.eventCount === 1 ? 'deduplicated' : 'unknown'), providerRequestId: item.result?.providerRequestId || item.storedRequest?.providerRequestId || null })), skipped: report.skipped }, null, 2)}\n`);
  } finally { await prisma.$disconnect(); }
}

main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
