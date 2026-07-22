const express = require('express');
const { z } = require('zod');
const { AppError } = require('../errors');
const { asyncRoute } = require('./helpers');
const { jsonSafe } = require('./billing.routes');

const uuid = z.string().uuid();
const usdMinorAmount = z.number().int().safe().min(100);

function paymentRoutes(repository, payments, spendSummary) {
  const router = express.Router();
  router.get('/purchase-options', asyncRoute(async (req, res) => {
    res.json({ ok: true, paymentsEnabled: payments.enabled, currency: 'USD', minimumAmount: 100, defaultAmount: 1000 });
  }));
  router.get('/spend', asyncRoute(async (req, res) => {
    if (!spendSummary) return res.json(jsonSafe({ ok: true, totalCostUSD: 0, totalTokens: 0, totalCredits: 0, totalCreditMicros: '0', providers: {}, projects: [], unpriced: [] }));
    const summary = await spendSummary.getTenantSpend(req.auth.tenantId);
    res.json(jsonSafe({ ok: true, ...summary }));
  }));
  router.get('/pricing', asyncRoute(async (req, res) => {
    if (!spendSummary) return res.json(jsonSafe({ ok: true, prices: [], markup: null, creditRate: null }));
    const pricing = await spendSummary.getActivePricing();
    res.json(jsonSafe({ ok: true, ...pricing }));
  }));
  router.post('/checkout', asyncRoute(async (req, res) => {
    const idempotencyKey = String(req.get('Idempotency-Key') || '').trim();
    if (!idempotencyKey || idempotencyKey.length > 200) throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key header is required', { status: 400 });
    const input = z.object({ amount: usdMinorAmount }).parse(req.body);
    const checkout = await payments.createCheckout({
      amount: input.amount, tenantId: req.auth.tenantId, userId: req.auth.userId,
      userEmail: req.user.email, idempotencyKey,
    });
    res.status(201).json(jsonSafe({ ok: true, checkout }));
  }));
  router.get('/balance', asyncRoute(async (req, res) => {
    const account = await repository.account(req.auth.tenantId);
    res.json(jsonSafe({
      ok: true,
      account: account || { availableCreditMicros: 0n, reservedCreditMicros: 0n },
    }));
  }));
  router.get('/purchases', asyncRoute(async (req, res) => {
    const [purchases, account] = await Promise.all([
      repository.listPurchases({ tenantId: req.auth.tenantId, userId: req.auth.userId, limit: req.query.limit }),
      repository.account(req.auth.tenantId),
    ]);
    res.json(jsonSafe({ ok: true, purchases, account }));
  }));
  router.get('/checkout/:saleId/status', asyncRoute(async (req, res) => {
    const sale = await repository.purchaseStatus({ saleId: uuid.parse(req.params.saleId), tenantId: req.auth.tenantId, userId: req.auth.userId });
    res.json(jsonSafe({ ok: true, sale }));
  }));
  return router;
}

function stripeWebhookHandler(payments) {
  return async (req, res, next) => {
    try {
      const event = payments.constructWebhookEvent(req.body, req.get('Stripe-Signature'));
      const result = await payments.processWebhook(event);
      res.json({ received: true, duplicate: result?.duplicate === true });
    } catch (error) { next(error); }
  };
}

module.exports = { paymentRoutes, stripeWebhookHandler };
