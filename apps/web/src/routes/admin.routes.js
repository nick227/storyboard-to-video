const express = require('express');
const { z } = require('zod');
const { bootstrapAdmin, styleAdmin } = require('../middleware/style-admin');
const { asyncRoute } = require('./helpers');
const { jsonSafe } = require('./billing.routes');

const uuid = z.string().uuid();
const unsignedInteger = z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).transform((value) => BigInt(value));
function optionalUuid(value) { return value ? uuid.parse(String(value)) : undefined; }
function date(value) { return value ? z.coerce.date().parse(value) : undefined; }

function adminRoutes(repository, queue, paymentRepository, payments) {
  const router = express.Router();
  router.use(styleAdmin);
  router.get('/overview', asyncRoute(async (req, res) => res.json(jsonSafe({ ok: true, overview: await repository.overview({ startAt: date(req.query.startAt), endAt: date(req.query.endAt) }) }))));
  router.get('/users', asyncRoute(async (req, res) => res.json(jsonSafe({ ok: true, users: await repository.listUsers({ search: req.query.search ? String(req.query.search) : undefined, status: req.query.status ? String(req.query.status) : undefined, role: req.query.role ? String(req.query.role) : undefined, limit: req.query.limit }) }))));
  router.patch('/users/:userId/status', asyncRoute(async (req, res) => {
    const input = z.object({ status: z.enum(['active', 'disabled']), reason: z.string().min(1).max(1000) }).parse(req.body);
    const user = await repository.setUserStatus({ userId: uuid.parse(req.params.userId), status: input.status, actorUserId: req.auth.userId, reason: input.reason, requestId: req.id });
    res.json({ ok: true, user });
  }));
  router.patch('/users/:userId/role', asyncRoute(async (req, res) => {
    const input = z.object({ platformRole: z.enum(['user', 'admin', 'super_admin']), reason: z.string().min(1).max(1000) }).parse(req.body);
    const user = await repository.setPlatformRole({ userId: uuid.parse(req.params.userId), platformRole: input.platformRole, actorUserId: req.auth.userId, actorRole: bootstrapAdmin(req) ? 'super_admin' : req.auth.platformRole, reason: input.reason, requestId: req.id });
    res.json({ ok: true, user });
  }));
  router.get('/sales', asyncRoute(async (req, res) => res.json(jsonSafe({ ok: true, sales: await repository.listSales({ tenantId: optionalUuid(req.query.tenantId), limit: req.query.limit }) }))));
  router.post('/sales', asyncRoute(async (req, res) => {
    const input = z.object({
      tenantId: uuid, customerUserId: uuid, cashAmountNanoUsd: unsignedInteger, creditsPurchasedMicros: unsignedInteger,
      currency: z.string().length(3).default('USD'), paymentProvider: z.string().min(1).max(80).default('manual'),
      externalPaymentId: z.string().min(1).max(200).nullable().optional(), occurredAt: z.coerce.date().default(() => new Date()),
      notes: z.string().max(2000).optional(), idempotencyKey: z.string().min(1).max(200),
    }).parse(req.body);
    const result = await repository.recordSale({ ...input, actorUserId: req.auth.userId, requestId: req.id });
    res.status(result.reused ? 200 : 201).json(jsonSafe({ ok: true, ...result }));
  }));
  router.post('/sales/:saleId/refund', asyncRoute(async (req, res) => {
    const input = z.object({ amount: unsignedInteger.optional(), reason: z.enum(['duplicate', 'fraudulent', 'requested_by_customer']).default('requested_by_customer'), idempotencyKey: z.string().min(1).max(200) }).parse(req.body);
    const result = await payments.refundSale({ saleId: uuid.parse(req.params.saleId), amount: input.amount, reason: input.reason, idempotencyKey: input.idempotencyKey });
    await repository.recordAudit({ actorUserId: req.auth.userId, tenantId: result.sale.tenantId, action: 'sale.refunded', targetType: 'credit_sale', targetId: result.sale.id, reason: input.reason, after: { processorRefundId: result.refund.id, amount: result.refund.amount, status: result.sale.status }, requestId: req.id });
    res.json(jsonSafe({ ok: true, ...result }));
  }));
  router.get('/credit-packs', asyncRoute(async (req, res) => res.json(jsonSafe({ ok: true, packs: await paymentRepository.listPacks() }))));
  router.post('/credit-packs', asyncRoute(async (req, res) => {
    const input = z.object({ code: z.string().regex(/^[a-z0-9-]+$/).max(80), version: z.number().int().positive(), name: z.string().min(1).max(120), currency: z.string().length(3).default('USD'), unitAmount: unsignedInteger, creditsGrantedMicros: unsignedInteger, taxBehavior: z.enum(['exclusive', 'inclusive', 'unspecified']).default('exclusive') }).parse(req.body);
    const pack = await paymentRepository.createPack(input);
    await repository.recordAudit({ actorUserId: req.auth.userId, action: 'credit_pack.created', targetType: 'credit_pack', targetId: pack.id, after: { code: pack.code, version: pack.version, unitAmount: pack.unitAmount.toString(), creditsGrantedMicros: pack.creditsGrantedMicros.toString() }, requestId: req.id });
    res.status(201).json(jsonSafe({ ok: true, pack }));
  }));
  router.patch('/credit-packs/:packId/publish', asyncRoute(async (req, res) => {
    const input = z.object({ stripePriceId: z.string().regex(/^price_[A-Za-z0-9_]+$/).max(255), activeFrom: z.coerce.date().default(() => new Date()) }).parse(req.body);
    const pack = await payments.publishCreditPack({ packId: uuid.parse(req.params.packId), ...input });
    await repository.recordAudit({ actorUserId: req.auth.userId, action: 'credit_pack.published', targetType: 'credit_pack', targetId: pack.id, after: { stripePriceId: pack.stripePriceId, activeFrom: pack.activeFrom }, requestId: req.id });
    res.json(jsonSafe({ ok: true, pack }));
  }));
  router.patch('/credit-packs/:packId/retire', asyncRoute(async (req, res) => {
    const pack = await paymentRepository.retirePack(uuid.parse(req.params.packId));
    await repository.recordAudit({ actorUserId: req.auth.userId, action: 'credit_pack.retired', targetType: 'credit_pack', targetId: pack.id, after: { activeUntil: pack.activeUntil }, requestId: req.id });
    res.json(jsonSafe({ ok: true, pack }));
  }));
  router.get('/generations', asyncRoute(async (req, res) => res.json(jsonSafe({ ok: true, generations: await repository.listGenerations({ tenantId: optionalUuid(req.query.tenantId), userId: optionalUuid(req.query.userId), modality: req.query.modality ? String(req.query.modality) : undefined, provider: req.query.provider ? String(req.query.provider) : undefined, status: req.query.status ? String(req.query.status) : undefined, limit: req.query.limit }) }))));
  router.delete('/jobs/:jobId', asyncRoute(async (req, res) => {
    const jobId = uuid.parse(req.params.jobId);
    const job = await queue.cancel(jobId);
    await repository.recordAudit({ actorUserId: req.auth.userId, tenantId: job.tenantId || null, action: 'generation.cancelled', targetType: 'generation_job', targetId: jobId, reason: req.body?.reason || 'Administrative cancellation', after: { status: job.status }, requestId: req.id });
    res.json(jsonSafe({ ok: true, job }));
  }));
  router.get('/audit', asyncRoute(async (req, res) => res.json(jsonSafe({ ok: true, events: await repository.listAudit({ limit: req.query.limit }) }))));
  return router;
}

module.exports = { adminRoutes };
