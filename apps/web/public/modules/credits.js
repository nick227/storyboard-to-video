const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
  const response = await fetch(path, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Request failed (${response.status})`);
  return data;
}
function esc(value) { return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function credits(value) { return (Number(value || 0) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 }); }
function money(amount, currency = 'USD') { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(amount || 0) / 100); }
function notice(text, error = false) { $('checkoutNotice').textContent = text; $('checkoutNotice').classList.toggle('error', error); }

async function load() {
  const [catalog, history, usage] = await Promise.all([api('/api/billing/credit-packs'), api('/api/billing/purchases'), api('/api/billing/spend')]);
  $('creditBalance').textContent = `${credits(history.account?.availableCreditMicros)} credits`;
  $('creditPacks').innerHTML = catalog.packs.map((pack) => `<article class="credit-pack"><h3>${esc(pack.name)}</h3><strong class="pack-price">${money(pack.unitAmount, pack.currency)}</strong><span class="pack-credits">${credits(pack.creditsGrantedMicros)} credits</span><button class="primary" data-pack="${pack.id}" ${catalog.paymentsEnabled ? '' : 'disabled'}>${catalog.paymentsEnabled ? 'Continue to Checkout' : 'Payments not configured'}</button></article>`).join('') || '<p>No credit packs are currently available.</p>';
  $('purchasesBody').innerHTML = history.purchases.map((sale) => `<tr><td>${new Date(sale.createdAt).toLocaleString()}</td><td>${esc(sale.creditPack?.name || 'Credit purchase')}</td><td>${money(sale.totalAmount, sale.currency)}</td><td>${credits(sale.creditsGranted)}</td><td><span class="status-pill">${esc(sale.status)}</span>${sale.refundResolutionRequired ? '<small> Admin resolution required</small>' : ''}</td></tr>`).join('') || '<tr><td colspan="5">No purchases yet.</td></tr>';
  $('usageTotalCredits').textContent = `${Number(usage.totalCredits || 0).toFixed(2)} credits`;
  $('usageProjectsBody').innerHTML = (usage.projects || []).map((project) => `<tr><td>${esc(project.title || 'Untitled')}</td><td>${Number(project.credits || 0).toFixed(2)}</td><td>${money(Math.round(Number(project.costUSD || 0) * 100))}</td><td>${Number(project.tokens || 0).toLocaleString()}</td></tr>`).join('') || '<tr><td colspan="4">No usage recorded yet.</td></tr>';
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

$('creditPacks').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-pack]'); if (!button) return;
  button.disabled = true; notice('Creating secure Checkout…');
  try { const { checkout } = await api('/api/billing/checkout', { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: { creditPackId: button.dataset.pack } }); location.assign(checkout.url); }
  catch (error) { notice(error.message, true); button.disabled = false; }
});

const params = new URLSearchParams(location.search);
if (params.get('checkout') === 'canceled') notice('Checkout was canceled. No credits were issued.');
await load();
if (params.get('checkout') === 'success' && params.get('saleId')) { notice('Waiting for Stripe payment confirmation…'); await pollSale(params.get('saleId')); }
