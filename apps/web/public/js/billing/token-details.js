const MODALITIES = {
  text: { label: 'Text', icon: '📝' },
  image: { label: 'Image', icon: '🎨' },
  audio: { label: 'Audio', icon: '🔊' },
  video: { label: 'Video', icon: '🎬' },
};

const REQUEST_COLUMNS = [
  { key: 'occurredAt', label: 'Date' },
  { key: 'modality', label: 'Type' },
  { key: 'provenance', label: 'Provenance' },
  { key: 'costUSD', label: 'Cost' },
  { key: 'file', label: 'File / usage' },
];

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return null;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 ** 2)).toFixed(2)} MB`;
}

function formatDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function costLabel(row) {
  if (row.billingTier === 'platform_overhead') return { cost: 'Included', credits: '0.00', muted: true };
  if (row.unpriced) return { cost: '⚠ Unpriced', credits: '—', muted: true };
  return {
    cost: `$${Number(row.costUSD || 0).toFixed(5)}`,
    credits: Number(row.credits || 0).toFixed(4),
    muted: false,
  };
}

function fileLabel(row) {
  const parts = [];
  const file = row.file || {};
  if (row.modality === 'text') {
    parts.push(`${Number(row.inputTokens || 0).toLocaleString()} in / ${Number(row.outputTokens || 0).toLocaleString()} out`);
    if (row.tokens) parts.push(`${Number(row.tokens).toLocaleString()} tokens`);
  } else if (row.modality === 'image') {
    parts.push(`${Number(row.count || 1)} image(s)`);
  } else if (row.modality === 'audio') {
    parts.push(`${Number(row.count || 0).toLocaleString()} chars`);
    if (row.seconds) parts.push(`${Number(row.seconds).toFixed(1)}s`);
  } else if (row.modality === 'video') {
    parts.push(`${Number(row.count || 1)} video(s)`);
    if (row.frames) parts.push(`${Number(row.frames)} frames`);
  }
  const size = formatBytes(file.bytes);
  if (size) parts.push(size);
  if (file.mimeType) parts.push(file.mimeType);
  else if (file.extension) parts.push(`.${file.extension}`);
  if (file.outputPath) {
    const name = String(file.outputPath).split(/[/\\]/).pop();
    if (name) parts.push(name);
  }
  return parts.join(' · ') || '—';
}

function provenanceLabel(row) {
  const scene = row.sceneId ? `scene ${row.sceneId}` : 'project';
  return `${row.provider} / ${row.model} · ${scene}`;
}

export function buildTokenDetailsViewModel(spend = {}, { sortKey = 'occurredAt', sortDir = 'desc' } = {}) {
  const {
    totalCostUSD = 0,
    totalTokens = 0,
    totalCredits = 0,
    providers = {},
    unpriced = [],
    requests = [],
  } = spend;

  const groups = Object.fromEntries(Object.entries(MODALITIES).map(([key, value]) => [
    key,
    { key, ...value, costUSD: 0, credits: 0, count: 0 },
  ]));

  for (const providerData of Object.values(providers)) {
    for (const [modality, modalityData] of Object.entries(providerData.modalities || {})) {
      const group = groups[modality];
      if (!group) continue;
      group.costUSD += Number(modalityData.costUSD || 0);
      group.count += Number(modalityData.count || 0);
    }
  }

  const rows = requests.map((request) => {
    const money = costLabel(request);
    return {
      ...request,
      provenance: provenanceLabel(request),
      fileLabel: fileLabel(request),
      costLabel: money.cost,
      creditsLabel: money.credits,
      costMuted: money.muted,
      sortCost: request.unpriced ? -1 : Number(request.costUSD || 0),
    };
  });

  const direction = sortDir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    let left;
    let right;
    if (sortKey === 'costUSD') {
      left = a.sortCost;
      right = b.sortCost;
    } else if (sortKey === 'file') {
      left = a.fileLabel;
      right = b.fileLabel;
    } else if (sortKey === 'provenance') {
      left = a.provenance;
      right = b.provenance;
    } else if (sortKey === 'modality') {
      left = a.modality;
      right = b.modality;
    } else {
      left = a.occurredAt || '';
      right = b.occurredAt || '';
    }
    if (left < right) return -1 * direction;
    if (left > right) return 1 * direction;
    return 0;
  });

  return {
    totalCostUSD: Number(totalCostUSD || 0),
    totalTokens: Number(totalTokens || 0),
    totalCredits: Number(totalCredits || 0),
    groups: Object.values(groups).filter((group) => group.count > 0 || group.costUSD > 0),
    unpriced,
    unpricedCount: unpriced.reduce((sum, item) => sum + Number(item.count || 0), 0),
    requests: rows,
    sortKey,
    sortDir,
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

function renderModalityTotals(groups) {
  const bar = element('div', 'tokens-modality-totals');
  for (const group of groups) {
    const chip = element('div', 'tokens-modality-total');
    chip.append(
      element('span', '', `${group.icon} ${group.label}`),
      element('strong', '', `$${group.costUSD.toFixed(5)}`),
    );
    bar.append(chip);
  }
  return bar;
}

function renderRequestsTable(viewModel, onSort) {
  const wrap = element('div', 'tokens-requests-wrap');
  wrap.append(element('h3', 'tokens-section-title', 'AI requests'));

  if (!viewModel.requests.length) {
    wrap.append(element('div', 'tokens-empty', 'No AI requests recorded'));
    return wrap;
  }

  const table = element('table', 'tokens-table tokens-requests-table');
  const head = element('thead');
  const headingRow = element('tr');
  for (const column of REQUEST_COLUMNS) {
    const th = element('th');
    const button = element('button', 'tokens-sort-btn', column.label);
    button.type = 'button';
    button.dataset.sortKey = column.key;
    if (viewModel.sortKey === column.key) {
      button.dataset.sortDir = viewModel.sortDir;
      button.append(viewModel.sortDir === 'asc' ? ' ▲' : ' ▼');
    }
    button.addEventListener('click', () => {
      const nextDir = viewModel.sortKey === column.key && viewModel.sortDir === 'desc' ? 'asc' : 'desc';
      onSort(column.key, nextDir);
    });
    th.append(button);
    headingRow.append(th);
  }
  head.append(headingRow);

  const body = element('tbody');
  for (const row of viewModel.requests) {
    const tr = element('tr');
    const costCell = element('td', row.costMuted ? 'tokens-muted' : 'tokens-cost-cell');
    costCell.append(
      element('div', 'tokens-cost-usd', row.costLabel),
      element('div', 'tokens-cost-credits', `${row.creditsLabel} credits`),
    );
    tr.append(
      element('td', 'tokens-date', formatDate(row.occurredAt)),
      element('td', 'tokens-modality', row.modality),
      element('td', '', row.provenance),
      costCell,
      element('td', 'tokens-file', row.fileLabel),
    );
    body.append(tr);
  }
  table.append(head, body);
  wrap.append(table);
  return wrap;
}

function renderSpend(container, spend, sortState) {
  const viewModel = buildTokenDetailsViewModel(spend, sortState);
  if (!viewModel.groups.length && !viewModel.requests.length) {
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
  if (viewModel.groups.length) children.push(renderModalityTotals(viewModel.groups));
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
  children.push(renderRequestsTable(viewModel, (sortKey, sortDir) => {
    renderSpend(container, spend, { sortKey, sortDir });
  }));
  container.replaceChildren(...children);
}

export function renderTokenDetails(els, spend) {
  if (els.tokensSpendContainer) renderSpend(els.tokensSpendContainer, spend || {}, { sortKey: 'occurredAt', sortDir: 'desc' });
}
