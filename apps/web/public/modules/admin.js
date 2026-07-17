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

async function loadOverview() {
  const query = new URLSearchParams(); if ($('overviewStart').value) query.set('startAt', `${$('overviewStart').value}T00:00:00Z`); if ($('overviewEnd').value) { const end = new Date(`${$('overviewEnd').value}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 1); query.set('endAt', end.toISOString()); }
  const o = (await api(`/api/admin/overview?${query}`)).overview;
  const cards = [
    ['Net cash sales', usd(o.netSalesNanoUsd || 0)], ['Credits sold', credit(o.sales._sum.creditsPurchasedMicros || 0)],
    ['Provider cost', usd(o.providerCostNanoUsd)], ['Nominal charges', usd(o.nominalChargeNanoUsd)], ['Gross margin', usd(o.grossMarginNanoUsd)],
    ['Credits outstanding', credit(o.accounts._sum.availableCreditMicros || 0)], ['Credits reserved', credit(o.accounts._sum.reservedCreditMicros || 0)],
    ['Settlement pending', o.settlementPendingCount], ['Negative margin', o.negativeMarginCount],
  ];
  $('overviewCards').innerHTML = cards.map(([label, value]) => `<div class="metric"><small>${esc(label)}</small><strong>${esc(value)}</strong></div>`).join('');
  $('overviewStatuses').innerHTML = o.requestsByStatus.map((row) => `<p>${pill(row.status, row.status === 'failed' ? 'bad' : row.status === 'completed' ? 'good' : 'warn')} ${row._count}</p>`).join('') || '<p>No requests.</p>';
  $('overviewTypes').innerHTML = o.requestsByType.map((row) => `<p>${pill(row.modality)} ${row._count}</p>`).join('') || '<p>No requests.</p>';
}

async function loadUsers() {
  const query = new URLSearchParams({ limit: '200' }); if ($('userSearch').value) query.set('search', $('userSearch').value); if ($('userStatus').value) query.set('status', $('userStatus').value); if ($('userRole').value) query.set('role', $('userRole').value);
  users = (await api(`/api/admin/users?${query}`)).users;
  $('usersBody').innerHTML = users.map((user) => {
    const membership = user.memberships[0]; const tenant = membership?.workspace; const account = tenant?.creditAccount;
    return `<tr><td><strong>${esc(user.displayName)}</strong><small>${esc(user.email)}</small><small class="break">${esc(user.id)}</small></td><td>${esc(tenant?.name || '—')}<small class="break">${esc(tenant?.id || '')}</small></td><td>${credit(account?.availableCreditMicros || 0)}<small>${credit(account?.reservedCreditMicros || 0)} reserved · charging ${account?.chargingEnabled ? 'on' : 'off'}</small></td><td>${user._count.generationRequests}<small>${user._count.sessions} sessions</small></td><td>${pill(user.status, user.status === 'active' ? 'good' : 'bad')}</td><td>${pill(user.platformRole)}</td><td><div class="row-actions"><button data-action="status" data-user="${user.id}">${user.status === 'active' ? 'Disable' : 'Enable'}</button><button data-action="role" data-user="${user.id}">Role</button><button data-action="credits" data-user="${user.id}">Give credits</button><button data-action="charging" data-user="${user.id}">${account?.chargingEnabled ? 'Stop charging' : 'Allow charging'}</button><button data-action="sale" data-user="${user.id}">Record sale</button></div></td></tr>`;
  }).join('');
}

async function userAction(button) {
  const user = users.find((item) => item.id === button.dataset.user); const tenant = user?.memberships[0]?.workspace; if (!user) return;
  const action = button.dataset.action;
  if (action === 'status') { const status = user.status === 'active' ? 'disabled' : 'active'; const reason = prompt(`Reason to mark ${user.email} ${status}:`); if (!reason) return; await api(`/api/admin/users/${user.id}/status`, { method: 'PATCH', body: { status, reason } }); }
  if (action === 'role') { const platformRole = prompt('Platform role: user, admin, or super_admin', user.platformRole); if (!platformRole || platformRole === user.platformRole) return; const reason = prompt('Reason for role change:'); if (!reason) return; await api(`/api/admin/users/${user.id}/role`, { method: 'PATCH', body: { platformRole, reason } }); }
  if (action === 'credits') { const amount = prompt('Site credits to grant:'); if (!amount) return; const notes = prompt('Reason for grant:'); if (!notes) return; await api('/api/admin/billing/credits/grant', { method: 'POST', body: { tenantId: tenant.id, creditMicros: decimalUnits(amount, 6), idempotencyKey: `admin-grant:${crypto.randomUUID()}`, notes } }); }
  if (action === 'charging') { const enabled = !tenant.creditAccount?.chargingEnabled; if (!confirm(`${enabled ? 'Enable' : 'Disable'} charging for ${tenant.name}?`)) return; await api(`/api/admin/billing/accounts/${tenant.id}/charging`, { method: 'PATCH', body: { enabled, idempotencyKey: `admin-charging:${crypto.randomUUID()}` } }); }
  if (action === 'sale') { const form = $('saleForm'); form.customerUserId.value = user.id; form.tenantId.value = tenant.id; document.querySelector('[data-tab="commerce"]').click(); form.cashUsd.focus(); return; }
  message('User updated.'); await Promise.all([loadUsers(), loadOverview()]);
}

async function loadCommerce() {
  const [billing, sales, packs] = await Promise.all([api('/api/admin/billing'), api('/api/admin/sales?limit=100'), api('/api/admin/credit-packs')]);
  $('pricesBody').innerHTML = billing.prices.map((price) => `<tr><td>${esc(price.provider)}</td><td>${esc(price.model)}<small>${esc(price.versionKey)}</small></td><td>${esc(price.modality)}</td><td>${pill(price.evidenceStatus, price.evidenceStatus === 'dashboard_reconciled' ? 'good' : 'warn')}</td><td>${price.active ? 'Yes' : 'No'}</td><td>${price.billable ? pill('Yes','good') : pill('No','warn')}</td><td>${usd(price.reservationNanoUsd)}</td></tr>`).join('');
  const welcome = billing.welcomeCreditPolicies.find((policy) => policy.active);
  $('activeWelcomeCredits').textContent = welcome ? `${credit(welcome.creditMicros)} credits · ${welcome.versionKey}` : 'No active welcome-credit policy';
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
$('adminRefresh').addEventListener('click', loadCurrent); $('overviewApply').addEventListener('click', loadOverview); $('usersApply').addEventListener('click', loadUsers); $('generationsApply').addEventListener('click', loadGenerations);
$('usersBody').addEventListener('click', (event) => { const button = event.target.closest('button[data-action]'); if (button) userAction(button).catch((error) => message(error.message, true)); });
$('generationsBody').addEventListener('click', async (event) => { const button = event.target.closest('button[data-cancel-job]'); if (!button || !confirm('Cancel this running job?')) return; try { await api(`/api/admin/jobs/${button.dataset.cancelJob}`, { method: 'DELETE', body: { reason: 'Cancelled from admin console' } }); await loadGenerations(); } catch (error) { message(error.message, true); } });
$('creditPacksBody').addEventListener('click', async (event) => { const publish = event.target.closest('button[data-publish-pack]'); const retire = event.target.closest('button[data-retire-pack]'); try { if (publish) { const stripePriceId = prompt('Stripe Price ID (price_…):'); if (!stripePriceId) return; await api(`/api/admin/credit-packs/${publish.dataset.publishPack}/publish`, { method: 'PATCH', body: { stripePriceId } }); } if (retire && confirm('Retire this pack immediately? Existing sales remain unchanged.')) await api(`/api/admin/credit-packs/${retire.dataset.retirePack}/retire`, { method: 'PATCH', body: {} }); await loadCommerce(); } catch (error) { message(error.message, true); } });
$('salesBody').addEventListener('click', async (event) => { const button = event.target.closest('button[data-refund-sale]'); if (!button || !confirm('Issue a full Stripe refund and remove the unspent purchased credits?')) return; try { await api(`/api/admin/sales/${button.dataset.refundSale}/refund`, { method: 'POST', body: { reason: 'requested_by_customer', idempotencyKey: crypto.randomUUID() } }); message('Refund created and credits reversed.'); await Promise.all([loadCommerce(), loadOverview()]); } catch (error) { message(error.message, true); } });
$('saleForm').addEventListener('submit', async (event) => { event.preventDefault(); try { const input = formObject(event.currentTarget); await api('/api/admin/sales', { method: 'POST', body: { tenantId: input.tenantId, customerUserId: input.customerUserId, cashAmountNanoUsd: decimalUnits(input.cashUsd, 9), creditsPurchasedMicros: decimalUnits(input.siteCredits, 6), currency: 'USD', paymentProvider: 'manual', externalPaymentId: input.externalPaymentId || null, occurredAt: new Date().toISOString(), notes: input.notes, idempotencyKey: `manual-sale:${crypto.randomUUID()}` } }); event.currentTarget.reset(); message('Sale recorded and credits granted.'); await Promise.all([loadCommerce(), loadOverview()]); } catch (error) { message(error.message, true); } });
$('markupForm').addEventListener('submit', async (event) => { event.preventDefault(); try { const input = formObject(event.currentTarget); await api('/api/admin/billing/markups', { method: 'POST', body: { versionKey: input.versionKey, name: input.versionKey, markupBasisPoints: Math.round(Number(input.percent) * 100), fixedNanoUsd: '0', active: true } }); event.currentTarget.reset(); message('Markup version activated.'); await loadCommerce(); } catch (error) { message(error.message, true); } });
$('creditRateForm').addEventListener('submit', async (event) => { event.preventDefault(); try { const input = formObject(event.currentTarget); await api('/api/admin/billing/credit-rates', { method: 'POST', body: { versionKey: input.versionKey, nanoUsdPerSiteCredit: decimalUnits(input.usdPerCredit, 9), active: true } }); event.currentTarget.reset(); message('Credit conversion activated.'); await loadCommerce(); } catch (error) { message(error.message, true); } });
$('welcomeCreditForm').addEventListener('submit', async (event) => { event.preventDefault(); try { const input = formObject(event.currentTarget); await api('/api/admin/billing/welcome-credits', { method: 'POST', body: { versionKey: input.versionKey, name: input.versionKey, creditMicros: decimalUnits(input.credits, 6), active: true } }); event.currentTarget.reset(); message('Welcome credits updated for future users. Existing balances were not changed.'); await loadCommerce(); } catch (error) { message(error.message, true); } });
$('adminLogout').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST', body: {} }); location.href = '/login.html'; });

const session = await api('/api/auth/session');
if (!session.authenticated || !['admin', 'super_admin'].includes(session.session.user.platformRole)) { $('adminIdentity').textContent = 'Bootstrap administrator'; } else { $('adminIdentity').textContent = `${session.session.user.displayName} · ${session.session.user.platformRole}`; }
await loadOverview();
