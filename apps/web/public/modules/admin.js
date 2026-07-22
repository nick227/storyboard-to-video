import { formatRateCard, formatMarkup, formatCreditRate } from './pricing-format.js';

const $ = (id) => document.getElementById(id);
let users = [];

async function api(path, options = {}) {
  const response = await fetch(path, { headers: options.body ? { 'Content-Type': 'application/json' } : undefined, ...options, body: options.body ? JSON.stringify(options.body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error?.message || `Request failed (${response.status})`); error.code = data.error?.code; throw error; }
  return data;
}
function esc(value) { return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function decimalUnits(value, decimals) { const [whole = '0', fraction = ''] = String(value).trim().split('.'); if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction)) throw new Error('Enter a positive number'); return (BigInt(whole) * (10n ** BigInt(decimals)) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals))).toString(); }
function usd(nano) { return nano == null ? '—' : `$${(Number(nano) / 1e9).toFixed(4)}`; }
function minorUsd(amount) { return amount == null ? '—' : `$${(Number(amount) / 100).toFixed(2)}`; }
function credit(micros) { return micros == null ? '—' : `${(Number(micros) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 })}`; }
function when(value) { return value ? new Date(value).toLocaleString() : '—'; }
function pill(value, tone = '') { return `<span class="pill ${tone}">${esc(value)}</span>`; }
function message(text, error = false) { $('adminMessage').textContent = text || ''; $('adminMessage').classList.toggle('error', error); }
function formObject(form) { return Object.fromEntries(new FormData(form).entries()); }
function versionStamp(prefix) { return `${prefix}-${new Date().toISOString().slice(0, 10)}`; }

const MODALITY_LABELS = {
  text: 'Writing & prompts',
  image: 'Images',
  audio: 'Voice & audio',
  video: 'Video',
  alignment: 'Subtitles',
};
const STATUS_LABELS = {
  completed: { label: 'Succeeded', tone: 'good', hint: 'Finished normally' },
  failed: { label: 'Failed', tone: 'bad', hint: 'Needs attention' },
  started: { label: 'In progress', tone: 'warn', hint: 'Still running or stuck' },
};

function money(nano) {
  const dollars = Number(nano || 0) / 1e9;
  if (!Number.isFinite(dollars) || dollars === 0) return '$0.00';
  if (dollars >= 10000) return `$${(dollars / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k`;
  return `$${dollars.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function overviewCard(label, value, note = '') {
  return `<div class="overview-card"><span class="overview-card-label">${esc(label)}</span><strong class="overview-card-value">${esc(value)}</strong>${note ? `<span class="overview-card-note">${esc(note)}</span>` : ''}</div>`;
}

function breakdownRows(rows, total, labelFor) {
  if (!total) return '<p class="breakdown-empty">Nothing in this period yet.</p>';
  return rows.map((row) => {
    const label = labelFor(row);
    const pct = Math.max(4, Math.round((row._count / total) * 100));
    return `<div class="breakdown-row"><span class="breakdown-label">${esc(label)}</span><div class="breakdown-bar" aria-hidden="true"><span style="width:${pct}%"></span></div><span class="breakdown-value">${row._count.toLocaleString()}</span></div>`;
  }).join('');
}

let overviewPeriod = '30';

function overviewRange(period) {
  if (period === 'all') return {};
  const days = Number(period);
  const end = new Date();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return { start, end };
}

function overviewPeriodLabel(period) {
  if (period === 'all') return 'Showing all time';
  const { start, end } = overviewRange(period);
  const fmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return `Showing ${fmt.format(start)} – ${fmt.format(end)}`;
}

function overviewQuery(period) {
  const query = new URLSearchParams();
  const { start, end } = overviewRange(period);
  if (start) query.set('startAt', start.toISOString());
  if (end) {
    const endExclusive = new Date(end);
    endExclusive.setDate(endExclusive.getDate() + 1);
    endExclusive.setHours(0, 0, 0, 0);
    query.set('endAt', endExclusive.toISOString());
  }
  return query;
}

async function loadOverview() {
  const query = overviewQuery(overviewPeriod);
  const [o, sanity] = await Promise.all([
    api(`/api/admin/overview?${query}`).then((r) => r.overview),
    api(`/api/admin/billing/sanity-report?${query}`),
  ]);
  $('overviewPeriodLabel').textContent = overviewPeriodLabel(overviewPeriod);

  const purchaseCount = o.sales._count || 0;
  const creditsSold = o.sales._sum.creditsPurchasedMicros || 0;
  const completed = o.requestsByStatus.find((row) => row.status === 'completed')?._count || 0;
  const failed = o.requestsByStatus.find((row) => row.status === 'failed')?._count || 0;
  const total = o.totalGenerations || 0;
  const successRate = total ? Math.round((completed / total) * 100) : null;

  $('overviewRevenue').innerHTML = [
    overviewCard('Credit purchases', money(o.netSalesNanoUsd), purchaseCount ? `${purchaseCount} checkout${purchaseCount === 1 ? '' : 's'} completed` : 'No purchases in this period'),
    overviewCard('Credits sold', credit(creditsSold), 'Total credits customers received'),
    overviewCard('Estimated profit', money(o.estimatedProfitNanoUsd), `Provider spend ${money(o.providerCostNanoUsd)} · customer usage ${money(o.customerChargeNanoUsd)}`),
  ].join('');

  $('overviewActivity').innerHTML = [
    overviewCard('AI generations', total.toLocaleString(), 'Every image, voice, video, or text request'),
    overviewCard('Active creators', (o.activeUsers || 0).toLocaleString(), 'Users who ran at least one generation'),
    overviewCard('Success rate', successRate == null ? '—' : `${successRate}%`, failed ? `${failed.toLocaleString()} failed · ${completed.toLocaleString()} succeeded` : completed ? `${completed.toLocaleString()} succeeded` : 'No finished runs yet'),
  ].join('');

  const types = [...o.requestsByType].sort((a, b) => b._count - a._count);
  $('overviewTypes').innerHTML = breakdownRows(types, total, (row) => MODALITY_LABELS[row.modality] || row.modality);

  const statuses = ['completed', 'failed', 'started']
    .map((status) => o.requestsByStatus.find((row) => row.status === status))
    .filter(Boolean)
    .sort((a, b) => b._count - a._count);
  const statusTotal = statuses.reduce((sum, row) => sum + row._count, 0) || total;
  $('overviewStatuses').innerHTML = breakdownRows(statuses, statusTotal, (row) => STATUS_LABELS[row.status]?.label || row.status);

  $('overviewBillingSanity').innerHTML = [
    overviewCard('Customer billable spend', money(Math.round(sanity.customerBillableSpendUSD * 1e9)), 'External provider calls actually metered to customers'),
    overviewCard('Platform included spend', money(Math.round(sanity.platformIncludedSpendUSD * 1e9)), 'Local/Modal cost tracked but not charged, by design'),
    overviewCard('Unpriced usage', sanity.unpricedUsageCount.toLocaleString(), sanity.unpricedUsageCount ? 'Generations with no configured price -- a real gap' : 'Every generation resolved to a price'),
    overviewCard('Reservations still held', sanity.reservationsHeld.toLocaleString(), sanity.reservationsHeld ? 'Live reservations not yet settled or released' : 'Nothing stuck mid-flight'),
    overviewCard('Failed settlements', sanity.failedSettlements.toLocaleString(), 'Reservations tied to a provider failure (released or failed_not_charged)'),
    overviewCard('Refunds issued', `${sanity.refundsIssued.count.toLocaleString()}`, `${credit(sanity.refundsIssued.creditMicros)} credits refunded to customers`),
  ].join('');
}

async function loadUsers() {
  const query = new URLSearchParams({ limit: '200' }); if ($('userSearch').value) query.set('search', $('userSearch').value); if ($('userStatus').value) query.set('status', $('userStatus').value); if ($('userRole').value) query.set('role', $('userRole').value);
  users = (await api(`/api/admin/users?${query}`)).users;
  $('usersBody').innerHTML = users.map((user) => {
    const membership = user.memberships[0]; const tenant = membership?.workspace; const account = tenant?.creditAccount;
    return `<tr><td><strong>${esc(user.displayName)}</strong><small>${esc(user.email)}</small><small class="break">${esc(user.id)}</small></td><td>${esc(tenant?.name || '—')}<small class="break">${esc(tenant?.id || '')}</small></td><td>${credit(account?.availableCreditMicros || 0)}<small>${credit(account?.reservedCreditMicros || 0)} reserved · charging ${account?.chargingEnabled ? 'on' : 'off'}</small></td><td>${user._count.generationRequests}<small>${user._count.sessions} sessions</small></td><td>${pill(user.status, user.status === 'active' ? 'good' : 'bad')}</td><td>${pill(user.platformRole)}</td><td><div class="row-actions"><button data-action="status" data-user="${user.id}">${user.status === 'active' ? 'Disable' : 'Enable'}</button><button data-action="role" data-user="${user.id}">Role</button><button data-action="credits" data-user="${user.id}">Give credits</button><button data-action="charging" data-user="${user.id}">${account?.chargingEnabled ? 'Stop charging' : 'Allow charging'}</button></div></td></tr>`;
  }).join('');
}

async function userAction(button) {
  const user = users.find((item) => item.id === button.dataset.user); const tenant = user?.memberships[0]?.workspace; if (!user) return;
  const action = button.dataset.action;
  if (action === 'status') { const status = user.status === 'active' ? 'disabled' : 'active'; const reason = prompt(`Reason to mark ${user.email} ${status}:`); if (!reason) return; await api(`/api/admin/users/${user.id}/status`, { method: 'PATCH', body: { status, reason } }); }
  if (action === 'role') { const platformRole = prompt('Platform role: user, admin, or super_admin', user.platformRole); if (!platformRole || platformRole === user.platformRole) return; const reason = prompt('Reason for role change:'); if (!reason) return; await api(`/api/admin/users/${user.id}/role`, { method: 'PATCH', body: { platformRole, reason } }); }
  if (action === 'credits') { const amount = prompt('Site credits to grant:'); if (!amount) return; const notes = prompt('Reason for grant:'); if (!notes) return; await api('/api/admin/billing/credits/grant', { method: 'POST', body: { tenantId: tenant.id, creditMicros: decimalUnits(amount, 6), idempotencyKey: `admin-grant:${crypto.randomUUID()}`, notes } }); }
  if (action === 'charging') { const enabled = !tenant.creditAccount?.chargingEnabled; if (!confirm(`${enabled ? 'Enable' : 'Disable'} charging for ${tenant.name}?`)) return; await api(`/api/admin/billing/accounts/${tenant.id}/charging`, { method: 'PATCH', body: { enabled, idempotencyKey: `admin-charging:${crypto.randomUUID()}` } }); }
  message('User updated.'); await Promise.all([loadUsers(), loadOverview()]);
}

function renderEconomics(billing) {
  const markup = billing.markups.find((row) => row.active);
  const creditRate = billing.creditRates.find((row) => row.active);
  const welcome = billing.welcomeCreditPolicies.find((policy) => policy.active);
  $('activeMarkup').textContent = formatMarkup(markup);
  $('activeCreditRate').textContent = formatCreditRate(creditRate);
  $('activeWelcomeCredits').textContent = welcome ? `${credit(welcome.creditMicros)} credits` : 'Not configured';
  if (markup) $('markupForm').percent.value = (Number(markup.markupBasisPoints || 0) / 100).toFixed(2);
  else $('markupForm').percent.value = '1';
  if (creditRate) $('creditRateForm').usdPerCredit.value = (Number(creditRate.nanoUsdPerSiteCredit || 0) / 1e9).toFixed(6);
  else $('creditRateForm').usdPerCredit.value = '1.000000';
  if (welcome) $('welcomeCreditForm').credits.value = (Number(welcome.creditMicros || 0) / 1e6).toFixed(2);
  else $('welcomeCreditForm').credits.value = '10';
}

let cachedPrices = [];

const TIER_LABELS = { customer_metered: 'Customer-metered', platform_overhead: 'Platform-overhead' };

function tierPill(billingTier) {
  if (billingTier === 'customer_metered') return pill(TIER_LABELS.customer_metered, 'good');
  if (billingTier === 'platform_overhead') return pill(TIER_LABELS.platform_overhead, '');
  return pill('Untagged', 'warn');
}

function renderPrices() {
  const tierFilter = $('priceTierFilter').value;
  const billableFilter = $('priceBillableFilter').value;
  const activePrices = cachedPrices
    .filter((price) => price.active)
    .filter((price) => {
      if (!tierFilter) return true;
      if (tierFilter === 'untagged') return !price.billingTier;
      return price.billingTier === tierFilter;
    })
    .filter((price) => !billableFilter || String(price.billable) === billableFilter)
    .sort((a, b) => `${a.provider}${a.modality}${a.model}`.localeCompare(`${b.provider}${b.modality}${b.model}`));
  $('pricesBody').innerHTML = activePrices.map((price) => `<tr data-price-id="${price.id}"><td>${esc(price.provider)}</td><td><code>${esc(price.model)}</code></td><td>${esc(price.modality)}</td><td>${esc(formatRateCard(price.rateCard))}</td><td>${usd(price.reservationNanoUsd)}</td><td>${tierPill(price.billingTier)}</td><td>${price.billable ? pill('Yes', 'good') : pill('No', 'warn')}</td><td><button data-toggle-billable="${price.id}" data-billable="${price.billable ? '1' : '0'}">${price.billable ? 'Disable billing' : 'Enable billing'}</button></td></tr>`).join('') || '<tr><td colspan="8">No provider prices match this filter.</td></tr>';
}

async function loadCommerce() {
  const [billing, sales, packs] = await Promise.all([api('/api/admin/billing'), api('/api/admin/sales?limit=100'), api('/api/admin/credit-packs')]);
  renderEconomics(billing);
  cachedPrices = billing.prices;
  renderPrices();
  $('creditPacksBody').innerHTML = packs.packs.map((pack) => `<tr><td>${esc(pack.name)}<small>${esc(pack.code)} v${pack.version}</small></td><td>$${(Number(pack.unitAmount) / 100).toFixed(2)}</td><td>${credit(pack.creditsGrantedMicros)}</td><td>${esc(pack.taxBehavior)}</td><td>${pill(pack.status, pack.status === 'active' ? 'good' : 'warn')}</td><td><small class="break">${esc(pack.stripePriceId || 'not configured')}</small></td><td>${pack.status === 'draft' ? `<button data-publish-pack="${pack.id}">Publish</button>` : pack.status === 'active' ? `<button data-retire-pack="${pack.id}">Retire</button>` : '—'}</td></tr>`).join('');
  $('salesBody').innerHTML = sales.sales.map((sale) => { const refundable = sale.processor === 'stripe' && ['credits_funded','partially_refunded'].includes(sale.status); const cash = sale.processor === 'stripe' ? `${minorUsd(BigInt(sale.totalAmount) - BigInt(sale.refundedAmount))}<small>${minorUsd(sale.refundedAmount)} refunded</small>` : usd(sale.cashAmountNanoUsd); return `<tr><td>${when(sale.occurredAt)}</td><td>${esc(sale.customerUser.displayName)}<small>${esc(sale.customerUser.email)}</small></td><td>${cash}</td><td>${credit(sale.creditsPurchasedMicros)}<small>${credit(sale.creditsReversed)} reversed</small></td><td>${esc(sale.paymentProvider)}<small>${esc(sale.processorCheckoutSessionId || sale.externalPaymentId || 'manual')}</small></td><td>${pill(sale.status, sale.status === 'credits_funded' ? 'good' : sale.refundResolutionRequired ? 'bad' : 'warn')}</td><td>${esc(sale.recordedByAdmin?.displayName || 'Stripe webhook')}</td><td>${refundable ? `<button data-refund-sale="${sale.id}">Refund</button>` : '—'}</td></tr>`; }).join('');
}

async function loadGenerations() {
  const query = new URLSearchParams({ limit: '200' }); if ($('generationType').value) query.set('modality', $('generationType').value); if ($('generationStatus').value) query.set('status', $('generationStatus').value); if ($('generationProvider').value) query.set('provider', $('generationProvider').value);
  const rows = (await api(`/api/admin/generations?${query}`)).generations;
  $('generationsBody').innerHTML = rows.map((row) => { const cost = row.costSnapshot?.providerCostNanoUsd; const charge = row.creditReservation?.finalCustomerNanoUsd; const margin = cost != null && charge != null ? BigInt(charge) - BigInt(cost) : null; const running = ['queued','running'].includes(row.job?.status); return `<tr><td>${when(row.startedAt)}<small>${row.completedAt ? `${Math.max(0,new Date(row.completedAt)-new Date(row.startedAt))} ms` : 'in progress'}</small></td><td>${esc(row.user?.displayName || 'system')}<small>${esc(row.tenant?.name || '')}</small></td><td>${esc(row.modality)} · ${esc(row.provider)}<small>${esc(row.model)}</small></td><td>${pill(row.status, row.status === 'failed' ? 'bad' : row.status === 'completed' ? 'good' : 'warn')}<small>${esc(row.creditReservation?.status || '')}</small></td><td>${esc(row.usageEvent?.measurementStatus || '—')}<small class="break">${esc(row.providerRequestId || '')}</small></td><td>${usd(cost)}</td><td>${usd(charge)}<small>${credit(row.creditReservation?.finalCreditMicros)} credits</small></td><td>${usd(margin)}</td><td>${esc(row.job?.status || '—')}${running ? `<small><button data-cancel-job="${row.job.id}">Cancel</button></small>` : ''}</td></tr>`; }).join('');
}
async function loadAudit() { const rows = (await api('/api/admin/audit?limit=200')).events; $('auditBody').innerHTML = rows.map((row) => `<tr><td>${when(row.createdAt)}</td><td>${esc(row.actor.displayName)}<small>${esc(row.actor.email)}</small></td><td>${esc(row.action)}</td><td>${esc(row.targetType)}<small class="break">${esc(row.targetId)}</small></td><td>${esc(row.reason || '—')}</td></tr>`).join(''); }

async function loadCurrent() { const tab = document.querySelector('.admin-tabs button.active').dataset.tab; message('Loading…'); try { if (tab === 'overview') await loadOverview(); if (tab === 'users') await loadUsers(); if (tab === 'commerce') await loadCommerce(); if (tab === 'generations') await loadGenerations(); if (tab === 'audit') await loadAudit(); message(''); } catch (error) { message(error.message, true); } }

document.querySelectorAll('.admin-tabs button').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('.admin-tabs button').forEach((item) => item.classList.toggle('active', item === button)); document.querySelectorAll('.admin-view').forEach((view) => { view.hidden = view.id !== `tab-${button.dataset.tab}`; }); loadCurrent(); }));
$('adminRefresh').addEventListener('click', loadCurrent);
document.querySelector('.period-picker')?.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-period]');
  if (!button) return;
  overviewPeriod = button.dataset.period;
  document.querySelectorAll('.period-picker button').forEach((item) => item.classList.toggle('active', item === button));
  loadOverview().catch((error) => message(error.message, true));
});
$('usersApply').addEventListener('click', loadUsers); $('generationsApply').addEventListener('click', loadGenerations);
$('pricesApply').addEventListener('click', renderPrices);
$('usersBody').addEventListener('click', (event) => { const button = event.target.closest('button[data-action]'); if (button) userAction(button).catch((error) => message(error.message, true)); });
$('generationsBody').addEventListener('click', async (event) => { const button = event.target.closest('button[data-cancel-job]'); if (!button || !confirm('Cancel this running job?')) return; try { await api(`/api/admin/jobs/${button.dataset.cancelJob}`, { method: 'DELETE', body: { reason: 'Cancelled from admin console' } }); await loadGenerations(); } catch (error) { message(error.message, true); } });
$('creditPacksBody').addEventListener('click', async (event) => { const publish = event.target.closest('button[data-publish-pack]'); const retire = event.target.closest('button[data-retire-pack]'); try { if (publish) { const stripePriceId = prompt('Stripe Price ID (price_…):'); if (!stripePriceId) return; await api(`/api/admin/credit-packs/${publish.dataset.publishPack}/publish`, { method: 'PATCH', body: { stripePriceId } }); } if (retire && confirm('Retire this pack immediately? Existing sales remain unchanged.')) await api(`/api/admin/credit-packs/${retire.dataset.retirePack}/retire`, { method: 'PATCH', body: {} }); await loadCommerce(); } catch (error) { message(error.message, true); } });
$('salesBody').addEventListener('click', async (event) => { const button = event.target.closest('button[data-refund-sale]'); if (!button || !confirm('Issue a full Stripe refund and remove the unspent purchased credits?')) return; try { await api(`/api/admin/sales/${button.dataset.refundSale}/refund`, { method: 'POST', body: { reason: 'requested_by_customer', idempotencyKey: crypto.randomUUID() } }); message('Refund created and credits reversed.'); await Promise.all([loadCommerce(), loadOverview()]); } catch (error) { message(error.message, true); } });
$('pricesBody').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-toggle-billable]');
  if (!button) return;
  const billable = button.dataset.billable !== '1';
  const label = billable ? 'Enable customer billing for this model?' : 'Disable customer billing for this model?';
  if (!confirm(label)) return;
  try {
    await api(`/api/admin/billing/prices/${button.dataset.toggleBillable}`, {
      method: 'PATCH',
      body: billable ? { billable: true, evidenceStatus: 'dashboard_reconciled', reconciledAt: new Date().toISOString() } : { billable: false },
    });
    message(billable ? 'Model is now billable.' : 'Model billing disabled.');
    await loadCommerce();
  } catch (error) { message(error.message, true); }
});
$('markupForm').addEventListener('submit', async (event) => { event.preventDefault(); try { const input = formObject(event.currentTarget); await api('/api/admin/billing/markups', { method: 'POST', body: { versionKey: versionStamp('markup'), name: 'Site markup', markupBasisPoints: Math.round(Number(input.percent) * 100), fixedNanoUsd: '0', active: true } }); message('Markup updated.'); await loadCommerce(); } catch (error) { message(error.message, true); } });
$('creditRateForm').addEventListener('submit', async (event) => { event.preventDefault(); try { const input = formObject(event.currentTarget); await api('/api/admin/billing/credit-rates', { method: 'POST', body: { versionKey: versionStamp('credit-rate'), nanoUsdPerSiteCredit: decimalUnits(input.usdPerCredit, 9), active: true } }); message('Credit value updated.'); await loadCommerce(); } catch (error) { message(error.message, true); } });
$('welcomeCreditForm').addEventListener('submit', async (event) => { event.preventDefault(); try { const input = formObject(event.currentTarget); await api('/api/admin/billing/welcome-credits', { method: 'POST', body: { versionKey: versionStamp('welcome'), name: 'Welcome credits', creditMicros: decimalUnits(input.credits, 6), active: true } }); message('Welcome credits updated for new users only.'); await loadCommerce(); } catch (error) { message(error.message, true); } });
await loadOverview();
