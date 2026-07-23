const { calculateProviderCost, convertNanoUsdToCreditMicros } = require('../billing/calculator');

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

function priceKey(provider, modality, model) { return `${provider}::${modality}::${model}`; }

function buildPriceIndex(prices) {
  const index = new Map();
  for (const price of prices) index.set(priceKey(price.provider, price.modality, price.model), price);
  return index;
}

// Single source of cost truth: a persisted ProviderCostSnapshot (real, from the moment the
// generation settled) if one exists, otherwise the same formal ProviderPriceVersion rate card
// computed live (for events that predate the price row, or ran while it was momentarily
// inactive) -- never a second, hand-maintained cost formula. `stub` is genuinely free, not
// unknown. Anything with no matching price at all is `unpriced`, not silently $0. `billingTier`
// (from the matched price, when one exists) tells the caller whether this cost is customer-facing
// or platform overhead included by design -- distinct from `unpriced`, a genuine gap.
function resolveEventCost(event, priceIndex) {
  const provider = event.provider || 'unknown';
  const modality = event.modality || 'unknown';
  const model = event.model || 'unknown';
  const price = priceIndex.get(priceKey(provider, modality, model));
  const billingTier = price?.billingTier || null;
  if (provider === 'stub') return { costUSD: 0, unpriced: false, billingTier };
  if (event.costSnapshot) return { costUSD: Number(event.costSnapshot.providerCostNanoUsd) / 1e9, unpriced: false, billingTier };
  if (!price) return { costUSD: 0, unpriced: true, billingTier: null };
  // A matched price can still fail to compute live (e.g. historical usage recorded with a
  // fractional value for a rate card that requires an integer unit -- a real data-quality gap,
  // not something to paper over). Same honesty rule as "no price matched": surface as unpriced,
  // never a silent $0, and never let one bad row crash an aggregate spend query.
  let cost;
  try {
    cost = calculateProviderCost(price.rateCard, event.usage || {});
  } catch {
    return { costUSD: 0, unpriced: true, billingTier: null };
  }
  return { costUSD: Number(cost.nanoUsd) / 1e9, unpriced: false, billingTier };
}

function aggregateEvents(events, prices = []) {
  const priceIndex = buildPriceIndex(prices);
  const providers = {};
  let totalCostUSD = 0;
  let platformCostUSD = 0;
  let totalTokens = 0;
  const unpricedByKey = new Map();

  for (const event of events) {
    const provider = event.provider || 'unknown';
    const modality = event.modality || 'unknown';
    const model = event.model || 'unknown';
    const { costUSD, unpriced, billingTier } = resolveEventCost(event, priceIndex);

    if (unpriced) {
      const key = priceKey(provider, modality, model);
      if (!unpricedByKey.has(key)) unpricedByKey.set(key, { provider, modality, model, count: 0 });
      unpricedByKey.get(key).count += 1;
    }

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
        unpriced: false,
        billingTier: null,
      };
    }

    const modelGroup = modalityGroup.models[model];
    modelGroup.costUSD += costUSD;
    modelGroup.tokens += tokens;
    modelGroup.inputTokens += input;
    modelGroup.outputTokens += output;
    if (unpriced) modelGroup.unpriced = true;
    if (billingTier) modelGroup.billingTier = billingTier;

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
      modelGroup.extra.seconds = (modelGroup.extra.seconds || 0) + Number(usage.seconds || 0);
    } else if (modality === 'video') {
      const count = Number(usage.videos || 1);
      modalityGroup.count += count;
      modelGroup.count += count;
      const frames = Number(usage.frames || 0);
      modelGroup.extra.frames = (modelGroup.extra.frames || 0) + frames;
    } else {
      modalityGroup.count += 1;
      modelGroup.count += 1;
    }

    if (billingTier === 'platform_overhead') platformCostUSD += costUSD;
    else totalCostUSD += costUSD;
    totalTokens += tokens;
  }

  return { providers, totalCostUSD, platformCostUSD, totalTokens, unpriced: [...unpricedByKey.values()] };
}

function createSpendSummaryService({ prisma, billingRepository }) {
  async function activePrices() {
    return prisma.providerPriceVersion.findMany({ where: { active: true } });
  }

  async function withCredits(totalCostUSD) {
    const rate = billingRepository ? await billingRepository.activeCreditRate() : null;
    if (!rate) return { creditMicros: 0n, credits: 0 };
    const nanoUsd = BigInt(Math.max(0, Math.round(totalCostUSD * 1e9)));
    const creditMicros = convertNanoUsdToCreditMicros(nanoUsd, rate);
    return { creditMicros, credits: Number(creditMicros) / 1e6 };
  }

  async function getProjectSpend(projectId) {
    const [events, prices] = await Promise.all([
      prisma.usageEvent.findMany({ where: { projectId }, include: { costSnapshot: true } }),
      activePrices(),
    ]);
    return aggregateEvents(events, prices);
  }

  async function getTenantSpend(tenantId) {
    const [events, projects, prices] = await Promise.all([
      prisma.usageEvent.findMany({ where: { tenantId }, include: { costSnapshot: true } }),
      prisma.project.findMany({ where: { tenantId }, select: { id: true, title: true } }),
      activePrices(),
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
      const { totalCostUSD, platformCostUSD, totalTokens, unpriced } = aggregateEvents(projectEvents, prices);
      const { credits, creditMicros } = await withCredits(totalCostUSD);
      projectSummaries.push({
        projectId,
        title: titleById.get(projectId) || null,
        costUSD: totalCostUSD,
        platformCostUSD,
        tokens: totalTokens,
        credits,
        creditMicros: creditMicros.toString(),
        unpriced,
      });
    }
    projectSummaries.sort((a, b) => b.costUSD - a.costUSD);

    const { providers, totalCostUSD, platformCostUSD, totalTokens, unpriced } = aggregateEvents(events, prices);
    const { credits, creditMicros } = await withCredits(totalCostUSD);

    return { totalCostUSD, platformCostUSD, totalTokens, totalCredits: credits, totalCreditMicros: creditMicros.toString(), providers, projects: projectSummaries, unpriced };
  }

  async function getActivePricing() {
    const [prices, markup, creditRate] = await Promise.all([
      prisma.providerPriceVersion.findMany({ where: { active: true }, orderBy: [{ provider: 'asc' }, { modality: 'asc' }, { model: 'asc' }] }),
      billingRepository ? billingRepository.activeMarkup() : null,
      billingRepository ? billingRepository.activeCreditRate() : null,
    ]);
    return { prices: localJsonSafe(prices), markup: localJsonSafe(markup), creditRate: localJsonSafe(creditRate) };
  }

  // Site-wide (not single-tenant) spend split, for the admin billing sanity report: how much of
  // all usage in the window is customer_metered (what's actually billed) vs platform_overhead
  // (tracked but included by design) vs genuinely unpriced (a real gap).
  async function getPlatformSpend({ startAt, endAt } = {}) {
    const range = { ...(startAt ? { gte: startAt } : {}), ...(endAt ? { lt: endAt } : {}) };
    const [events, prices] = await Promise.all([
      prisma.usageEvent.findMany({ where: Object.keys(range).length ? { occurredAt: range } : {}, include: { costSnapshot: true } }),
      activePrices(),
    ]);
    return aggregateEvents(events, prices);
  }

  return { localJsonSafe, aggregateEvents, withCredits, getProjectSpend, getTenantSpend, getActivePricing, getPlatformSpend };
}

module.exports = { createSpendSummaryService, aggregateEvents, localJsonSafe };
