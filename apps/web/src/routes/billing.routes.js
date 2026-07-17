const express = require('express');
const { z } = require('zod');
const { AppError } = require('../errors');
const { styleAdmin } = require('../middleware/style-admin');
const { asyncRoute } = require('./helpers');

const uuid = z.string().uuid();
const unsignedInteger = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform((value) => BigInt(value));
const jsonUnsignedInteger = z.number().int().nonnegative().safe();
const rateCard = z.discriminatedUnion('type', [
  z.object({ type: z.literal('token_components'), components: z.array(z.object({ usageKey: z.string().min(1), subtractUsageKey: z.string().min(1).optional(), nanoUsdPerMillion: jsonUnsignedInteger })).min(1) }),
  z.object({ type: z.literal('linear_steps'), usageKey: z.string().min(1), quantityKey: z.string().min(1).optional(), baseNanoUsd: jsonUnsignedInteger, baseUnits: z.number().int().positive().safe() }),
  z.object({ type: z.literal('flat'), quantityKey: z.string().min(1).optional(), nanoUsdPerUnit: jsonUnsignedInteger }),
]);
const priceInput = z.object({
  versionKey: z.string().min(1).max(160), provider: z.string().min(1).max(80), modality: z.string().min(1).max(40), model: z.string().min(1).max(160),
  currency: z.string().length(3).default('USD'), rateCard, reservationNanoUsd: unsignedInteger,
  evidenceStatus: z.enum(['documented', 'dashboard_reconciled', 'estimated']), reconciledAt: z.coerce.date().nullable().optional(),
  reconciliationNotes: z.string().max(4000).nullable().optional(), sourceReference: z.string().max(2000).nullable().optional(),
  billable: z.boolean().default(false), active: z.boolean().default(false),
});

function jsonSafe(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  return value;
}

function tenantFilter(value) { return value == null || value === '' ? undefined : uuid.parse(String(value)); }

function billingRoutes(repository, billing, adminRepository = null) {
  const router = express.Router();
  const audit = (req, event) => adminRepository?.recordAudit({ actorUserId: req.auth.userId, requestId: req.id, ...event });
  router.use(styleAdmin);
  router.get('/', asyncRoute(async (req, res) => {
    if (!repository) throw new AppError('BILLING_UNAVAILABLE', 'Billing persistence is unavailable', { status: 503 });
    const [prices, markups, creditRates, welcomeCreditPolicies, accounts] = await Promise.all([repository.listPrices(), repository.listMarkups(), repository.listCreditRates(), repository.listWelcomeCreditPolicies(), repository.listAccounts()]);
    res.json(jsonSafe({ ok: true, customerChargingEnabled: billing?.chargingEnabled === true, prices, markups, creditRates, welcomeCreditPolicies, accounts }));
  }));
  router.get('/ledger', asyncRoute(async (req, res) => res.json(jsonSafe({ ok: true, entries: await repository.listLedger({ tenantId: tenantFilter(req.query.tenantId), limit: req.query.limit }) }))));
  router.get('/margins', asyncRoute(async (req, res) => {
    const rows = await repository.listMargins({ tenantId: tenantFilter(req.query.tenantId), limit: req.query.limit });
    const margins = rows.map((row) => ({
      ...row,
      marginNanoUsd: row.finalCustomerNanoUsd == null || !row.providerCostSnapshot ? null : row.finalCustomerNanoUsd - row.providerCostSnapshot.providerCostNanoUsd,
    }));
    res.json(jsonSafe({ ok: true, margins }));
  }));
  router.post('/credits/grant', express.json(), asyncRoute(async (req, res) => {
    const input = z.object({ tenantId: uuid, creditMicros: unsignedInteger, idempotencyKey: z.string().min(1).max(200), notes: z.string().max(1000).optional() }).parse(req.body);
    const entry = await repository.grant({ tenantId: input.tenantId, userId: req.auth.userId, creditMicros: input.creditMicros, idempotencyKey: input.idempotencyKey, metadata: { notes: input.notes || null } });
    await audit(req, { tenantId: input.tenantId, action: 'credits.granted', targetType: 'tenant', targetId: input.tenantId, reason: input.notes, after: { creditMicros: input.creditMicros.toString(), ledgerEntryId: entry.id } });
    res.status(201).json(jsonSafe({ ok: true, entry }));
  }));
  router.patch('/accounts/:tenantId/charging', asyncRoute(async (req, res) => {
    const tenantId = uuid.parse(req.params.tenantId);
    const input = z.object({ enabled: z.boolean(), idempotencyKey: z.string().min(1).max(200) }).parse(req.body);
    const result = await repository.setChargingEnabled({ tenantId, enabled: input.enabled, actorUserId: req.auth.userId, idempotencyKey: input.idempotencyKey });
    if (!result.reused && !result.unchanged) await audit(req, { tenantId, action: input.enabled ? 'tenant.charging_enabled' : 'tenant.charging_disabled', targetType: 'credit_account', targetId: result.account.id, after: { chargingEnabled: input.enabled, ledgerEntryId: result.entry?.id } });
    res.json(jsonSafe({ ok: true, ...result }));
  }));
  router.post('/prices', asyncRoute(async (req, res) => {
    const input = priceInput.parse(req.body);
    if (input.billable && (input.evidenceStatus !== 'dashboard_reconciled' || !input.reconciledAt)) throw new AppError('PRICE_NOT_RECONCILED', 'A provider price must have dated dashboard reconciliation before it can be billable', { status: 409 });
    let price = await repository.createPriceVersion({ ...input, active: false });
    if (input.active) price = await repository.configurePrice(price.id, { active: true });
    await audit(req, { action: 'pricing.provider_version_created', targetType: 'provider_price_version', targetId: price.id, after: { versionKey: price.versionKey, provider: price.provider, model: price.model, active: price.active, billable: price.billable } });
    res.status(201).json(jsonSafe({ ok: true, price }));
  }));
  router.patch('/prices/:id', asyncRoute(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const input = z.object({ active: z.boolean().optional(), billable: z.boolean().optional(), evidenceStatus: z.enum(['documented', 'dashboard_reconciled', 'estimated']).optional(), reconciledAt: z.coerce.date().nullable().optional(), reconciliationNotes: z.string().max(4000).nullable().optional() }).parse(req.body);
    const price = await repository.configurePrice(id, input);
    await audit(req, { action: 'pricing.provider_version_configured', targetType: 'provider_price_version', targetId: id, after: { active: price.active, billable: price.billable, evidenceStatus: price.evidenceStatus, reconciledAt: price.reconciledAt } });
    res.json(jsonSafe({ ok: true, price }));
  }));
  router.post('/markups', asyncRoute(async (req, res) => {
    const input = z.object({ versionKey: z.string().min(1).max(160), name: z.string().min(1).max(200), markupBasisPoints: z.number().int().nonnegative().max(100000), fixedNanoUsd: unsignedInteger.default(0n), active: z.boolean().default(false) }).parse(req.body);
    let version = await repository.createMarkupVersion({ ...input, active: false });
    if (input.active) version = await repository.activateMarkup(version.id);
    await audit(req, { action: 'pricing.markup_version_created', targetType: 'markup_policy_version', targetId: version.id, after: { versionKey: version.versionKey, markupBasisPoints: version.markupBasisPoints, active: version.active } });
    res.status(201).json(jsonSafe({ ok: true, markup: version }));
  }));
  router.post('/credit-rates', asyncRoute(async (req, res) => {
    const input = z.object({ versionKey: z.string().min(1).max(160), nanoUsdPerSiteCredit: unsignedInteger, active: z.boolean().default(false) }).parse(req.body);
    if (input.nanoUsdPerSiteCredit === 0n) throw new AppError('INVALID_CREDIT_RATE', 'nanoUsdPerSiteCredit must be positive', { status: 400 });
    let version = await repository.createCreditRateVersion({ ...input, active: false });
    if (input.active) version = await repository.activateCreditRate(version.id);
    await audit(req, { action: 'pricing.credit_rate_version_created', targetType: 'site_credit_rate_version', targetId: version.id, after: { versionKey: version.versionKey, nanoUsdPerSiteCredit: version.nanoUsdPerSiteCredit.toString(), active: version.active } });
    res.status(201).json(jsonSafe({ ok: true, creditRate: version }));
  }));
  router.post('/welcome-credits', asyncRoute(async (req, res) => {
    const input = z.object({ versionKey: z.string().min(1).max(160), name: z.string().min(1).max(200), creditMicros: unsignedInteger, active: z.boolean().default(true) }).parse(req.body);
    if (input.creditMicros === 0n) throw new AppError('INVALID_WELCOME_CREDITS', 'Welcome credits must be positive', { status: 400 });
    const policy = await repository.createWelcomeCreditPolicyVersion({ ...input, createdByAdminId: req.auth.userId });
    await audit(req, { action: 'pricing.welcome_credit_policy_created', targetType: 'welcome_credit_policy_version', targetId: policy.id, after: { versionKey: policy.versionKey, creditMicros: policy.creditMicros.toString(), active: policy.active } });
    res.status(201).json(jsonSafe({ ok: true, policy }));
  }));
  return router;
}

module.exports = { billingRoutes, jsonSafe };
