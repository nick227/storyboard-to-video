const { convertNanoUsdToCreditMicros } = require('../billing/calculator');

function estimateUsageCost(event) {
  const provider = event.provider || 'unknown';
  const modality = event.modality || 'unknown';
  const usage = event.usage || {};

  if (provider === 'stub') {
    return 0;
  }

  if (modality === 'text') {
    if (provider === 'openai') {
      const input = Number(usage.inputTokens || 0);
      const cached = Number(usage.cachedInputTokens || 0);
      const output = Number(usage.outputTokens || 0);
      const nonCached = Math.max(0, input - cached);
      return (nonCached * 400 + cached * 100 + output * 1600) / 1e9;
    }
    if (provider === 'gemini') {
      const input = Number(usage.inputTokens || 0);
      const output = Number(usage.outputTokens || 0);
      return (input * 1500 + output * 9000) / 1e9;
    }
  }

  if (modality === 'image') {
    if (provider === 'openai') {
      const input = Number(usage.inputTokens || usage.inputTextTokens || 0);
      const output = Number(usage.outputTokens || usage.outputImageTokens || 0);
      return (input * 5000 + output * 40000) / 1e9;
    }
    if (provider === 'gemini') {
      const input = Number(usage.inputTokens || 0);
      const text = Number(usage.outputTextOrThinkingTokens || 0);
      const img = Number(usage.outputImageTokens || 0);
      return (input * 500 + text * 3000 + img * 60000) / 1e9;
    }
    if (provider === 'dezgo') {
      const steps = Number(usage.steps || 25);
      const images = Number(usage.images || 1);
      return (0.0181 * steps / 30) * images;
    }
  }

  if (modality === 'audio') {
    if (provider === 'elevenlabs') {
      const chars = Number(usage.characters || 0);
      return (chars / 1000) * 0.15;
    }
    if (provider === 'piper') {
      const bytes = Number(usage.outputBytes || 0);
      const seconds = bytes / 44100;
      return (seconds / 100) * 0.01;
    }
    if (provider === 'spark') {
      const bytes = Number(usage.outputBytes || 0);
      const seconds = bytes / 48000;
      return (seconds / 100) * 0.05;
    }
  }

  if (modality === 'video') {
    if (provider === 'ltx') {
      const videos = Number(usage.videos || 1);
      return videos * 0.015;
    }
  }

  return 0;
}

const estimatedPrices = [
  {
    provider: 'elevenlabs',
    modality: 'audio',
    model: 'eleven_turbo_v2_5',
    rate: '$0.15 per 1,000 characters',
    notes: 'Runs via ElevenLabs API (Starter/Creator tier average)',
  },
  {
    provider: 'piper',
    modality: 'audio',
    model: 'piper-local',
    rate: '$0.01 per 100 seconds of audio ($0.0001/sec)',
    notes: 'Runs locally or via Modal.com CPU/GPU container',
  },
  {
    provider: 'spark',
    modality: 'audio',
    model: 'spark-tts',
    rate: '$0.05 per 100 seconds of audio ($0.0005/sec)',
    notes: 'Runs locally or via Modal.com container',
  },
  {
    provider: 'ltx',
    modality: 'video',
    model: 'ltx-video',
    rate: '$0.015 per generation (approx. 5s at 24fps)',
    notes: 'Runs locally or via Modal.com A100 GPU instance',
  },
];

function localJsonSafe(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(localJsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [key, localJsonSafe(val)])
    );
  }
  return value;
}

function aggregateEvents(events) {
  const providers = {};
  let totalCostUSD = 0;
  let totalTokens = 0;

  for (const event of events) {
    const provider = event.provider || 'unknown';
    const modality = event.modality || 'unknown';
    const model = event.model || 'unknown';

    if (!providers[provider]) {
      providers[provider] = {
        costUSD: 0,
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        modalities: {},
      };
    }

    const usage = event.usage || {};
    const input = Number(usage.inputTokens || usage.inputTextTokens || 0);
    const output = Number(usage.outputTokens || usage.candidatesTokenCount || usage.thoughtsTokenCount || usage.outputImageTokens || 0);
    const tokens = Number(usage.totalTokens || usage.totalTokenCount || 0) || (input + output);

    let costUSD = 0;
    if (event.costSnapshot) {
      costUSD = Number(event.costSnapshot.providerCostNanoUsd) / 1e9;
    } else {
      costUSD = estimateUsageCost(event);
    }

    providers[provider].costUSD += costUSD;
    providers[provider].tokens += tokens;
    providers[provider].inputTokens += input;
    providers[provider].outputTokens += output;

    if (!providers[provider].modalities[modality]) {
      providers[provider].modalities[modality] = {
        costUSD: 0,
        tokens: 0,
        count: 0,
        models: {},
      };
    }

    const modalityGroup = providers[provider].modalities[modality];
    modalityGroup.costUSD += costUSD;
    modalityGroup.tokens += tokens;

    if (!modalityGroup.models[model]) {
      modalityGroup.models[model] = {
        costUSD: 0,
        tokens: 0,
        count: 0,
        inputTokens: 0,
        outputTokens: 0,
        extra: {},
      };
    }

    const modelGroup = modalityGroup.models[model];
    modelGroup.costUSD += costUSD;
    modelGroup.tokens += tokens;
    modelGroup.inputTokens += input;
    modelGroup.outputTokens += output;

    if (modality === 'text') {
      modalityGroup.count += 1;
      modelGroup.count += 1;
    } else if (modality === 'image') {
      const count = Number(usage.images || 1);
      modalityGroup.count += count;
      modelGroup.count += count;
    } else if (modality === 'audio') {
      const count = Number(usage.characters || 0);
      modalityGroup.count += count;
      modelGroup.count += count;
      modelGroup.extra.bytes = (modelGroup.extra.bytes || 0) + Number(usage.outputBytes || 0);
    } else if (modality === 'video') {
      const count = Number(usage.videos || 1);
      modalityGroup.count += count;
      modelGroup.count += count;
      const frames = Number(usage.frames || 0);
      modelGroup.extra.frames = (modelGroup.extra.frames || 0) + frames;
    }

    totalCostUSD += costUSD;
    totalTokens += tokens;
  }

  return { providers, totalCostUSD, totalTokens };
}

function createSpendSummaryService({ prisma, billingRepository }) {
  async function withCredits(totalCostUSD) {
    const rate = billingRepository ? await billingRepository.activeCreditRate() : null;
    if (!rate) return { creditMicros: 0n, credits: 0 };
    const nanoUsd = BigInt(Math.max(0, Math.round(totalCostUSD * 1e9)));
    const creditMicros = convertNanoUsdToCreditMicros(nanoUsd, rate);
    return { creditMicros, credits: Number(creditMicros) / 1e6 };
  }

  async function getProjectSpend(projectId) {
    const events = await prisma.usageEvent.findMany({
      where: { projectId },
      include: { costSnapshot: true },
    });
    return aggregateEvents(events);
  }

  async function getTenantSpend(tenantId) {
    const [events, projects] = await Promise.all([
      prisma.usageEvent.findMany({ where: { tenantId }, include: { costSnapshot: true } }),
      prisma.project.findMany({ where: { tenantId }, select: { id: true, title: true } }),
    ]);

    const eventsByProject = new Map();
    for (const event of events) {
      if (!event.projectId) continue;
      if (!eventsByProject.has(event.projectId)) eventsByProject.set(event.projectId, []);
      eventsByProject.get(event.projectId).push(event);
    }

    const titleById = new Map(projects.map((project) => [project.id, project.title]));
    const projectSummaries = [];
    for (const [projectId, projectEvents] of eventsByProject) {
      const { totalCostUSD, totalTokens } = aggregateEvents(projectEvents);
      const { credits, creditMicros } = await withCredits(totalCostUSD);
      projectSummaries.push({
        projectId,
        title: titleById.get(projectId) || null,
        costUSD: totalCostUSD,
        tokens: totalTokens,
        credits,
        creditMicros: creditMicros.toString(),
      });
    }
    projectSummaries.sort((a, b) => b.costUSD - a.costUSD);

    const { providers, totalCostUSD, totalTokens } = aggregateEvents(events);
    const { credits, creditMicros } = await withCredits(totalCostUSD);

    return { totalCostUSD, totalTokens, totalCredits: credits, totalCreditMicros: creditMicros.toString(), providers, projects: projectSummaries };
  }

  return { estimateUsageCost, estimatedPrices, localJsonSafe, aggregateEvents, withCredits, getProjectSpend, getTenantSpend };
}

module.exports = { createSpendSummaryService, estimateUsageCost, estimatedPrices, aggregateEvents, localJsonSafe };
