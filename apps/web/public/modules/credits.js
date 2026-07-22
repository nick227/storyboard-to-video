import { formatRateCard, formatMarkup, formatCreditRate } from './pricing-format.js';
import { creditStore } from './store.js';
import { formatCredits, refreshCreditBalance } from './credit-balance.js';

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
  const response = await fetch(path, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Request failed (${response.status})`);
  return data;
}
function esc(value) { return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function credits(value) { return formatCredits(value); }
function renderBalance(state = creditStore.get()) {
  $('creditBalance').textContent = `${formatCredits(state.availableCreditMicros)} credits`;
}
creditStore.subscribe(renderBalance);
function money(amount, currency = 'USD') { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(amount || 0) / 100); }
function notice(text, error = false) { $('checkoutNotice').textContent = text; $('checkoutNotice').classList.toggle('error', error); }
let purchaseContext = null;

function customerUnitCost(providerUsd, markup) {
  const percent = Number(markup?.markupBasisPoints || 0) / 10000;
  const fixed = Number(markup?.fixedNanoUsd || 0) / 1e9;
  return (providerUsd * (1 + percent)) + fixed;
}

function rateCardExample(price, markup) {
  const card = price.rateCard;
  let providerUsd = null;
  let kind = `${price.modality}_generations`;
  let detail = `Using ${price.model}`;
  let outputPerUnit = 1;
  if (card?.type === 'flat') {
    providerUsd = Number(card.nanoUsdPerUnit || 0) / 1e9;
    if (price.modality === 'image') kind = 'images';
    if (price.modality === 'video') {
      kind = 'videos';
      detail = `${price.model}; usually a short clip`;
    }
  }
  if (card?.type === 'linear_steps') {
    providerUsd = Number(card.baseNanoUsd || 0) / 1e9;
    if (price.modality === 'audio' && card.usageKey === 'seconds') {
      kind = 'audio_seconds';
      outputPerUnit = Number(card.baseUnits || 1);
      detail = `Spoken audio using ${price.model}`;
    } else if (price.modality === 'image') {
      kind = 'images';
      detail = `${price.model} at about ${Number(card.baseUnits || 0)} steps per image`;
    }
  }
  if (card?.type === 'token_components' && price.modality === 'text') {
    const typicalUsage = { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 500 };
    providerUsd = (card.components || []).reduce((total, component) => {
      const units = Math.max(0, Number(typicalUsage[component.usageKey] || 0) - Number(typicalUsage[component.subtractUsageKey] || 0));
      return total + ((Number(component.nanoUsdPerMillion || 0) / 1e9) * units / 1e6);
    }, 0);
    kind = 'llm_responses';
    detail = `A normal AI writing request and response using ${price.model}`;
  }
  if (providerUsd == null) return null;
  const unitUsd = customerUnitCost(providerUsd, markup);
  return unitUsd > 0 ? { modality: price.modality, kind, detail, unitUsd, outputPerUnit } : null;
}

function generationExamples(pricing) {
  const configured = (pricing.prices || []).map((price) => rateCardExample(price, pricing.markup)).filter(Boolean);
  const byModality = new Map();
  for (const example of configured) if (!byModality.has(example.modality)) byModality.set(example.modality, example);
  return [...byModality.values()].slice(0, 4);
}

function durationText(seconds) {
  if (seconds < 60) return `${Math.max(1, Math.floor(seconds))} seconds`;
  if (seconds < 3600) return `${Math.floor(seconds / 60).toLocaleString()} minutes`;
  const hours = seconds / 3600;
  return `${hours.toLocaleString(undefined, { maximumFractionDigits: hours < 10 ? 1 : 0 })} hours`;
}

function outputEstimate(amountUsd, example) {
  const units = amountUsd / example.unitUsd;
  if (example.kind === 'audio_seconds') return { statement: `About ${durationText(units * example.outputPerUnit)} of audio`, detail: example.detail };
  const count = Math.floor(units);
  const nouns = { images: 'image', videos: 'video', llm_responses: 'AI text response' };
  const noun = nouns[example.kind] || 'generation';
  const statement = count < 1 ? `Less than 1 ${noun}` : `About ${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
  return { statement, detail: example.detail };
}

function scenarioLabel(example) {
  if (example.kind === 'images') return 'All on images';
  if (example.kind === 'audio_seconds') return 'All on audio';
  if (example.kind === 'videos') return 'All on video';
  if (example.kind === 'llm_responses') return 'All on AI text';
  return `All on ${example.modality}`;
}

function updatePurchaseEstimate() {
  if (!purchaseContext) return;
  const { options, pricing, examples } = purchaseContext;
  const amount = $('creditAmount').valueAsNumber;
  const rate = BigInt(pricing.creditRate?.nanoUsdPerSiteCredit || 0);
  if (!Number.isFinite(amount) || amount < options.minimumAmount / 100) {
    $('creditEstimate').textContent = `Minimum purchase: ${money(options.minimumAmount, options.currency)}`;
    $('generationEstimateList').innerHTML = '';
    return;
  }
  if (rate <= 0n) $('creditEstimate').textContent = 'Credit conversion is not configured.';
  else {
    const amountCents = BigInt(Math.round(amount * 100));
    const creditMicros = (amountCents * 10000000n * 1000000n) / rate;
    $('creditEstimate').textContent = `You’ll get ${credits(creditMicros)} credits.`;
  }
  $('generationEstimateList').innerHTML = examples.map((example) => {
    const estimate = outputEstimate(amount, example);
    return `<div class="generation-estimate-item"><strong>${esc(scenarioLabel(example))} → ${esc(estimate.statement.toLowerCase())}</strong><span>${esc(estimate.detail)}</span></div>`;
  }).join('') || '<p>We can’t estimate outputs until pricing is configured.</p>';
}

async function load() {
  const [options, history, usage, pricing] = await Promise.all([api('/api/billing/purchase-options'), api('/api/billing/purchases'), api('/api/billing/spend'), api('/api/billing/pricing'), refreshCreditBalance()]);
  renderBalance();
  $('purchasesBody').innerHTML = history.purchases.map((sale) => `<tr><td>${new Date(sale.createdAt).toLocaleString()}</td><td>${esc(sale.creditPack?.name || 'Credit purchase')}</td><td>${money(sale.totalAmount, sale.currency)}</td><td>${credits(sale.creditsGranted)}</td><td><span class="status-pill">${esc(sale.status)}</span>${sale.refundResolutionRequired ? '<small> Admin resolution required</small>' : ''}</td></tr>`).join('') || '<tr><td colspan="5">No purchases yet.</td></tr>';
  $('usageTotalCredits').textContent = `${Number(usage.totalCredits || 0).toFixed(2)} credits`;
  $('usageProjectsBody').innerHTML = (usage.projects || []).map((project) => `<tr><td>${esc(project.title || 'Untitled')}${project.unpriced?.length ? ' <small>(includes unpriced usage)</small>' : ''}</td><td>${Number(project.credits || 0).toFixed(2)}</td><td>${money(Math.round(Number(project.costUSD || 0) * 100))}</td><td>${Number(project.tokens || 0).toLocaleString()}</td></tr>`).join('') || '<tr><td colspan="4">No usage recorded yet.</td></tr>';
  const unpricedNote = $('usageUnpricedNote');
  const unpricedTotal = (usage.unpriced || []).reduce((sum, item) => sum + item.count, 0);
  if (unpricedTotal > 0) {
    unpricedNote.hidden = false;
    unpricedNote.textContent = `${unpricedTotal} generation(s) have no configured price yet and are not included in the totals above: ${usage.unpriced.map((item) => `${item.provider}/${item.model}`).join(', ')}`;
  } else {
    unpricedNote.hidden = true;
  }
  $('pricingMarkup').textContent = formatMarkup(pricing.markup);
  $('pricingCreditRate').textContent = formatCreditRate(pricing.creditRate);
  const pricingRows = pricing.prices.map((price) => ({ provider: price.provider, modality: price.modality, model: price.model, rate: formatRateCard(price.rateCard), billingTier: price.billingTier }));
  $('pricingBody').innerHTML = pricingRows.map((row) => { const billable = row.billingTier === 'customer_metered'; return `<tr><td>${esc(row.provider)}</td><td style="text-transform: capitalize;">${esc(row.modality)}</td><td><code>${esc(row.model)}</code></td><td>${esc(row.rate)}</td><td><span class="status-pill ${billable ? 'tier-billable' : 'tier-included'}">${billable ? 'Billable' : 'Included'}</span></td></tr>`; }).join('') || '<tr><td colspan="5">No pricing configured yet.</td></tr>';
  const examples = generationExamples(pricing);
  purchaseContext = { options, pricing, examples };
  if (!$('creditAmount').dataset.initialized) {
    $('creditAmount').value = (options.defaultAmount / 100).toFixed(2);
    $('creditAmount').dataset.initialized = 'true';
  }
  $('addCreditsButton').disabled = !options.paymentsEnabled || !pricing.creditRate;
  $('openAddCreditsButton').disabled = !options.paymentsEnabled || !pricing.creditRate;
  $('addCreditsButton').textContent = options.paymentsEnabled ? 'Continue' : 'Payments not configured';
  $('openAddCreditsButton').textContent = options.paymentsEnabled ? 'Add credits' : 'Payments unavailable';
  updatePurchaseEstimate();
  const representative = examples.find((example) => example.modality === 'image') || examples[0];
  $('pricingExamples').innerHTML = representative
    ? [5, 10, 25].map((amount) => { const estimate = outputEstimate(amount, representative); return `<div class="pricing-example"><strong>$${amount}</strong><span>${esc(estimate.statement)}</span></div>`; }).join('')
    : '<p>Examples will appear when a billable generation rate is configured.</p>';
}

async function pollSale(saleId) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const { sale } = await api(`/api/billing/checkout/${encodeURIComponent(saleId)}/status`);
    if (['credits_funded', 'partially_refunded', 'refunded', 'disputed'].includes(sale.status)) { notice(sale.status === 'credits_funded' ? 'Payment confirmed. Your credits are ready.' : `Purchase status: ${sale.status}.`); await load(); return; }
    if (sale.status === 'expired') { notice('This Checkout session expired without payment.', true); await load(); return; }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  notice('Payment is still processing. Refresh this page shortly; credits are funded only after Stripe confirms payment.');
}

$('addCreditsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('addCreditsButton');
  const amount = $('creditAmount').valueAsNumber;
  if (!event.currentTarget.reportValidity() || !Number.isFinite(amount)) return;
  button.disabled = true; notice('Creating secure Checkout…');
  try { const { checkout } = await api('/api/billing/checkout', { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: { amount: Math.round(amount * 100) } }); location.assign(checkout.url); }
  catch (error) { notice(error.message, true); button.disabled = false; }
});

$('creditAmount').addEventListener('input', updatePurchaseEstimate);
$('openAddCreditsButton').addEventListener('click', () => { $('addCreditsModal').showModal(); $('creditAmount').focus(); $('creditAmount').select(); });
$('closeAddCreditsModal').addEventListener('click', () => $('addCreditsModal').close());
$('pricingInfoButton').addEventListener('click', () => $('pricingModal').showModal());
$('closePricingModal').addEventListener('click', () => $('pricingModal').close());
$('addCreditsModal').addEventListener('click', (event) => { if (event.target === $('addCreditsModal')) $('addCreditsModal').close(); });
$('pricingModal').addEventListener('click', (event) => { if (event.target === $('pricingModal')) $('pricingModal').close(); });

const params = new URLSearchParams(location.search);
if (params.get('checkout') === 'canceled') notice('Checkout was canceled. No credits were issued.');
await load();
if (params.get('checkout') === 'success' && params.get('saleId')) { notice('Waiting for Stripe payment confirmation…'); await pollSale(params.get('saleId')); }
