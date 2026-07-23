import { formatRateCard } from './pricing-format.js';

const MODALITIES = {
  text: { label: 'Text Generation', icon: '📝' },
  image: { label: 'Image Generation', icon: '🎨' },
  audio: { label: 'Audio Synthesis', icon: '🔊' },
  video: { label: 'Video Generation', icon: '🎬' },
};

function usageDetails(modality, item) {
  if (modality === 'text') {
    return `${item.count} prompt(s) (${item.inputTokens.toLocaleString()} in / ${item.outputTokens.toLocaleString()} out)`;
  }
  if (modality === 'image') return `${item.count} image(s)`;
  if (modality === 'audio') {
    const seconds = Number(item.extra?.seconds || 0);
    return `${item.count.toLocaleString()} character(s)${seconds > 0 ? ` (~${seconds.toFixed(1)}s audio)` : ''}`;
  }
  if (modality === 'video') return `${item.count} video(s) (${item.extra?.frames || 0} frames total)`;
  return `${item.count} generation(s)`;
}

export function buildTokenDetailsViewModel(spend = {}) {
  const {
    totalCostUSD = 0,
    totalTokens = 0,
    totalCredits = 0,
    providers = {},
    activePrices = [],
    unpriced = [],
    videoModels = [],
  } = spend;
  const groups = Object.fromEntries(Object.entries(MODALITIES).map(([key, value]) => [
    key,
    { key, ...value, costUSD: 0, items: [] },
  ]));

  for (const [provider, providerData] of Object.entries(providers)) {
    for (const [modality, modalityData] of Object.entries(providerData.modalities || {})) {
      const group = groups[modality];
      if (!group) continue;
      group.costUSD += Number(modalityData.costUSD || 0);
      for (const [model, stats] of Object.entries(modalityData.models || {})) {
        const item = { provider, model, ...stats };
        group.items.push({
          ...item,
          usage: usageDetails(modality, item),
          costLabel: item.billingTier === 'platform_overhead'
            ? 'Included'
            : item.unpriced ? '⚠ Unpriced' : `$${Number(item.costUSD || 0).toFixed(5)}`,
        });
      }
    }
  }

  const pricingRows = activePrices.map((price) => ({
    provider: price.provider,
    modality: price.modality,
    model: price.model,
    rate: formatRateCard(price.rateCard),
  }));
  const pricedModels = new Set(activePrices.map((price) => `${price.provider}:${price.modality}:${price.model}`));
  for (const video of videoModels) {
    if (pricedModels.has(`${video.provider}:video:${video.model}`)) continue;
    const modes = (video.modes || []).map((mode) => mode.replaceAll('_', ' ')).join(', ');
    pricingRows.push({
      provider: video.provider,
      modality: 'video',
      model: video.model,
      isDefault: Boolean(video.isDefault),
      rate: `Rate not configured${modes ? ` · ${modes}` : ''}`,
    });
  }

  return {
    totalCostUSD: Number(totalCostUSD || 0),
    totalTokens: Number(totalTokens || 0),
    totalCredits: Number(totalCredits || 0),
    groups: Object.values(groups).filter((group) => group.items.length),
    unpriced,
    unpricedCount: unpriced.reduce((sum, item) => sum + Number(item.count || 0), 0),
    pricingRows,
  };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function summaryItem(label, value) {
  const item = element('span');
  item.append(`${label}: `, element('strong', '', value));
  return item;
}

function renderSpend(container, viewModel) {
  if (!viewModel.groups.length) {
    container.replaceChildren(element('div', 'tokens-empty', 'No tokens recorded'));
    return;
  }

  const summary = element('div', 'tokens-spend-summary');
  summary.append(
    summaryItem('Total Credits Spent', viewModel.totalCredits.toFixed(2)),
    summaryItem('Total Storyboard Spend', `$${viewModel.totalCostUSD.toFixed(5)} USD`),
    summaryItem('Total Tokens', viewModel.totalTokens.toLocaleString()),
  );
  const children = [summary];
  if (viewModel.unpriced.length) {
    const warning = element('div', 'tokens-unpriced-warning');
    warning.append(
      `⚠ ${viewModel.unpricedCount} generation(s) from `,
      viewModel.unpriced.map((item) => `${item.provider}/${item.model}`).join(', '),
      ' have no configured price yet and are ',
      element('strong', '', 'not included'),
      ' in the totals above.',
    );
    children.push(warning);
  }

  const grid = element('div', 'tokens-spend-grid');
  for (const group of viewModel.groups) {
    const card = element('div', 'tokens-spend-card');
    const heading = element('h4');
    heading.append(element('span', '', `${group.icon} ${group.label}`), element('span', 'cost', `$${group.costUSD.toFixed(5)}`));
    const providers = element('div', 'tokens-spend-card-providers');
    for (const item of group.items) {
      const row = element('div', 'tokens-spend-provider-row');
      const header = element('div', 'tokens-spend-provider-header');
      const provider = element('strong');
      provider.append(item.provider, ' ', element('span', 'tokens-model-name', `(${item.model})`));
      header.append(provider, element('span', item.unpriced || item.billingTier === 'platform_overhead' ? 'tokens-muted' : '', item.costLabel));
      const modelList = element('div', 'tokens-spend-model-list');
      const usage = element('div', 'tokens-spend-model-row');
      usage.append(element('span', '', `Usage: ${item.usage}`));
      if (item.tokens > 0) usage.append(element('span', '', `Tokens: ${item.tokens.toLocaleString()}`));
      modelList.append(usage);
      row.append(header, modelList);
      providers.append(row);
    }
    card.append(heading, providers);
    grid.append(card);
  }
  children.push(grid);
  container.replaceChildren(...children);
}

function renderPricing(container, rows) {
  const table = element('table', 'tokens-table');
  const head = element('thead');
  const headingRow = element('tr');
  for (const label of ['Provider', 'Modality', 'Model', 'Rate']) headingRow.append(element('th', '', label));
  head.append(headingRow);
  const body = element('tbody');
  for (const row of rows) {
    const tableRow = element('tr');
    const provider = element('td');
    provider.append(element('strong', '', row.provider));
    const modality = element('td', 'tokens-modality', row.modality);
    const model = element('td');
    model.append(element('code', '', row.model));
    if (row.isDefault) model.append(' ', element('span', 'tokens-muted', '(default)'));
    tableRow.append(provider, modality, model, element('td', '', row.rate));
    body.append(tableRow);
  }
  table.append(head, body);
  container.replaceChildren(table);
}

export function renderTokenDetails(els, spend) {
  const viewModel = buildTokenDetailsViewModel(spend);
  if (els.tokensSpendContainer) renderSpend(els.tokensSpendContainer, viewModel);
  if (els.tokensPricingContainer) renderPricing(els.tokensPricingContainer, viewModel.pricingRows);
}
