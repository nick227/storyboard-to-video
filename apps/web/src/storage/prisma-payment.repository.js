const crypto = require('node:crypto');
const { AppError } = require('../errors');

function json(value) { return value == null ? undefined : JSON.parse(JSON.stringify(value)); }
function customerId(value) { return typeof value === 'string' ? value : value?.id || null; }
async function serializable(prisma, work) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await prisma.$transaction(work, { isolationLevel: 'Serializable' }); }
    catch (error) {
      if (attempt >= 4 || (error.code !== 'P2034' && !/write conflict|deadlock/i.test(error.message))) throw error;
    }
  }
}

class PrismaPaymentRepository {
  constructor(prisma) { this.prisma = prisma; }

  listActivePacks(at = new Date()) {
    return this.prisma.creditPack.findMany({
      where: { status: 'active', activeFrom: { lte: at }, OR: [{ activeUntil: null }, { activeUntil: { gt: at } }] },
      orderBy: [{ unitAmount: 'asc' }, { version: 'desc' }],
    });
  }

  listPacks() { return this.prisma.creditPack.findMany({ orderBy: [{ code: 'asc' }, { version: 'desc' }] }); }
  findPack(id) { return this.prisma.creditPack.findUnique({ where: { id } }); }

  createPack(data) { return this.prisma.creditPack.create({ data: { id: crypto.randomUUID(), ...data, status: 'draft' } }); }

  publishPack(id, { stripePriceId, activeFrom = new Date() }) {
    return this.prisma.creditPack.update({ where: { id }, data: { stripePriceId, activeFrom, status: 'active' } });
  }

  retirePack(id, activeUntil = new Date()) {
    return this.prisma.creditPack.update({ where: { id }, data: { activeUntil, status: 'retired' } });
  }

  async prepareCheckout({ packId, tenantId, userId, idempotencyKey }) {
    return serializable(this.prisma, async (db) => {
      const prior = await db.checkoutAttempt.findUnique({
        where: { idempotencyKey }, include: { sale: { include: { creditPack: true } } },
      });
      if (prior) {
        if (prior.tenantId !== tenantId || prior.userId !== userId || prior.sale.creditPackId !== packId) {
          throw new AppError('IDEMPOTENCY_CONFLICT', 'That idempotency key belongs to another checkout', { status: 409 });
        }
        const paymentCustomer = await db.paymentCustomer.findUnique({ where: { tenantId_userId_processor: { tenantId, userId, processor: 'stripe' } } });
        return { attempt: prior, sale: prior.sale, pack: prior.sale.creditPack, paymentCustomer, reused: true };
      }
      const membership = await db.membership.findUnique({ where: { userId_tenantId: { userId, tenantId } } });
      if (!membership) throw new AppError('TENANT_ACCESS_DENIED', 'The current user is not a member of this workspace', { status: 403 });
      const now = new Date();
      const pack = await db.creditPack.findFirst({ where: { id: packId, status: 'active', activeFrom: { lte: now }, OR: [{ activeUntil: null }, { activeUntil: { gt: now } }] } });
      if (!pack || !pack.stripePriceId) throw new AppError('CREDIT_PACK_UNAVAILABLE', 'That credit pack is not available', { status: 404 });
      const saleId = crypto.randomUUID();
      const sale = await db.creditSale.create({ data: {
        id: saleId, tenantId, customerUserId: userId, creditPackId: pack.id,
        cashAmountNanoUsd: pack.unitAmount * 10000000n,
        creditsPurchasedMicros: pack.creditsGrantedMicros, creditsGranted: pack.creditsGrantedMicros,
        currency: pack.currency, paymentProvider: 'stripe', processor: 'stripe',
        subtotalAmount: pack.unitAmount, totalAmount: pack.unitAmount, status: 'pending', occurredAt: now,
      } });
      const attempt = await db.checkoutAttempt.create({ data: {
        id: crypto.randomUUID(), saleId, tenantId, userId, processor: 'stripe', idempotencyKey,
      } });
      const paymentCustomer = await db.paymentCustomer.findUnique({ where: { tenantId_userId_processor: { tenantId, userId, processor: 'stripe' } } });
      return { attempt, sale, pack, paymentCustomer, reused: false };
    });
  }

  async markCheckoutCreated({ attemptId, session }) {
    return serializable(this.prisma, async (db) => {
      const attempt = await db.checkoutAttempt.findUnique({ where: { id: attemptId }, include: { sale: true } });
      if (!attempt) throw new AppError('CHECKOUT_ATTEMPT_NOT_FOUND', 'Checkout attempt not found', { status: 404 });
      if (attempt.processorCheckoutSessionId) return attempt;
      await db.creditSale.update({ where: { id: attempt.saleId }, data: {
        status: 'checkout_created', processorCheckoutSessionId: session.id,
        processorCustomerId: customerId(session.customer),
      } });
      return db.checkoutAttempt.update({ where: { id: attempt.id }, data: {
        status: 'checkout_created', processorCheckoutSessionId: session.id, checkoutUrl: session.url,
      } });
    });
  }

  markCheckoutFailed(attemptId, error) {
    return this.prisma.checkoutAttempt.update({ where: { id: attemptId }, data: { status: 'failed', error: json({ message: error.message, code: error.code || null }) } });
  }

  async receiveEvent({ processorEventId, processorObjectId, type, payload }) {
    const existing = await this.prisma.paymentEvent.findUnique({ where: { processorEventId } });
    if (existing) return { event: existing, duplicate: true };
    if (processorObjectId) {
      const objectEvent = await this.prisma.paymentEvent.findUnique({ where: { processor_type_processorObjectId: { processor: 'stripe', type, processorObjectId } } });
      if (objectEvent) return { event: objectEvent, duplicate: true };
    }
    try {
      const event = await this.prisma.paymentEvent.create({ data: {
        id: crypto.randomUUID(), processor: 'stripe', processorEventId, processorObjectId: processorObjectId || null,
        type, payload: json(payload), status: 'received',
      } });
      return { event, duplicate: false };
    } catch (error) {
      if (error.code !== 'P2002') throw error;
      const event = await this.prisma.paymentEvent.findFirst({ where: { OR: [{ processorEventId }, ...(processorObjectId ? [{ processor: 'stripe', type, processorObjectId }] : [])] } });
      return { event, duplicate: true };
    }
  }

  failEvent(eventId, error) {
    return this.prisma.paymentEvent.update({ where: { id: eventId }, data: { status: 'failed', error: String(error.message || error).slice(0, 2000), processedAt: new Date() } });
  }

  ignoreEvent(eventId) {
    return this.prisma.paymentEvent.update({ where: { id: eventId }, data: { status: 'ignored', processedAt: new Date() } });
  }

  async fundCheckout(eventId, session) {
    return this.prisma.$transaction(async (db) => {
      const paymentEvent = await db.paymentEvent.findUnique({ where: { id: eventId } });
      if (!paymentEvent || paymentEvent.status === 'processed') return { duplicate: true };
      const saleId = session.metadata?.saleId || session.client_reference_id;
      const sale = await db.creditSale.findUnique({ where: { id: saleId } });
      if (!sale || sale.tenantId !== session.metadata?.tenantId || sale.customerUserId !== session.metadata?.userId) {
        throw new AppError('PAYMENT_SALE_MISMATCH', 'Checkout metadata does not match an internal sale', { status: 409 });
      }
      if (session.payment_status !== 'paid') throw new AppError('PAYMENT_NOT_PAID', 'Checkout completed without confirmed payment', { status: 409 });
      if (!['pending', 'checkout_created', 'paid'].includes(sale.status) && !sale.creditLedgerEntryId) throw new AppError('INVALID_SALE_TRANSITION', `A ${sale.status} sale cannot be funded`, { status: 409 });
      const subtotal = BigInt(session.amount_subtotal ?? 0);
      const total = BigInt(session.amount_total ?? 0);
      const tax = BigInt(session.total_details?.amount_tax ?? (total - subtotal));
      if (subtotal !== sale.subtotalAmount || String(session.currency || '').toUpperCase() !== sale.currency || total < subtotal || tax !== total - subtotal) {
        throw new AppError('PAYMENT_AMOUNT_MISMATCH', 'Stripe totals do not match the purchased credit pack', { status: 409 });
      }
      if (sale.creditLedgerEntryId) {
        await db.paymentEvent.update({ where: { id: eventId }, data: { saleId: sale.id, status: 'processed', processedAt: new Date(), error: null } });
        return { sale, duplicate: true };
      }
      const stripeCustomerId = customerId(session.customer);
      if (stripeCustomerId) await db.paymentCustomer.upsert({
        where: { tenantId_userId_processor: { tenantId: sale.tenantId, userId: sale.customerUserId, processor: 'stripe' } },
        update: { processorCustomerId: stripeCustomerId },
        create: { id: crypto.randomUUID(), tenantId: sale.tenantId, userId: sale.customerUserId, processor: 'stripe', processorCustomerId: stripeCustomerId },
      });
      let account = await db.creditAccount.upsert({ where: { tenantId: sale.tenantId }, update: {}, create: { id: crypto.randomUUID(), tenantId: sale.tenantId } });
      account = await db.creditAccount.update({ where: { id: account.id }, data: { availableCreditMicros: { increment: sale.creditsGranted } } });
      const ledger = await db.creditLedgerEntry.create({ data: {
        id: crypto.randomUUID(), accountId: account.id, tenantId: sale.tenantId, userId: sale.customerUserId, saleId: sale.id,
        type: 'purchase_funding', availableDeltaCreditMicros: sale.creditsGranted, reservedDeltaCreditMicros: 0n,
        availableAfterCreditMicros: account.availableCreditMicros, reservedAfterCreditMicros: account.reservedCreditMicros,
        idempotencyKey: `purchase-funding:${sale.id}`, metadata: { processor: 'stripe', checkoutSessionId: session.id, paymentIntentId: customerId(session.payment_intent) },
      } });
      const funded = await db.creditSale.update({ where: { id: sale.id }, data: {
        status: 'credits_funded', creditLedgerEntryId: ledger.id, processorCustomerId: stripeCustomerId,
        processorCheckoutSessionId: session.id, processorPaymentIntentId: customerId(session.payment_intent),
        taxAmount: tax, totalAmount: total, paidAt: new Date((session.created || Math.floor(Date.now() / 1000)) * 1000),
      } });
      await db.checkoutAttempt.updateMany({ where: { saleId: sale.id }, data: { status: 'completed', completedAt: new Date() } });
      await db.paymentEvent.update({ where: { id: eventId }, data: { saleId: sale.id, status: 'processed', processedAt: new Date(), error: null } });
      return { sale: funded, ledgerEntry: ledger, duplicate: false };
    });
  }

  async expireCheckout(eventId, session) {
    return serializable(this.prisma, async (db) => {
      const saleId = session.metadata?.saleId || session.client_reference_id;
      const sale = saleId ? await db.creditSale.findUnique({ where: { id: saleId } }) : null;
      if (sale && ['pending', 'checkout_created'].includes(sale.status)) await db.creditSale.update({ where: { id: sale.id }, data: { status: 'expired' } });
      if (sale) await db.checkoutAttempt.updateMany({ where: { saleId: sale.id }, data: { status: 'expired', completedAt: new Date() } });
      await db.paymentEvent.update({ where: { id: eventId }, data: { saleId: sale?.id || null, status: 'processed', processedAt: new Date() } });
      return sale;
    });
  }

  async markDisputed(eventId, dispute) {
    return this.prisma.$transaction(async (db) => {
      const paymentIntentId = customerId(dispute.payment_intent);
      const sale = paymentIntentId ? await db.creditSale.findUnique({ where: { processorPaymentIntentId: paymentIntentId } }) : null;
      if (sale) await db.creditSale.update({ where: { id: sale.id }, data: { status: 'disputed' } });
      await db.paymentEvent.update({ where: { id: eventId }, data: { saleId: sale?.id || null, status: sale ? 'processed' : 'ignored', processedAt: new Date() } });
      return sale;
    });
  }

  async assertRefundable(saleId, requestedAmount) {
    const sale = await this.prisma.creditSale.findUnique({ where: { id: saleId }, include: { tenant: { include: { creditAccount: true } } } });
    if (!sale || !['credits_funded', 'partially_refunded'].includes(sale.status) || !sale.processorPaymentIntentId) throw new AppError('SALE_NOT_REFUNDABLE', 'That sale is not refundable', { status: 409 });
    const remaining = sale.totalAmount - sale.refundedAmount;
    const amount = requestedAmount == null ? remaining : requestedAmount;
    if (amount <= 0n || amount > remaining) throw new AppError('INVALID_REFUND_AMOUNT', 'Refund amount exceeds the remaining paid amount', { status: 400 });
    const targetCredits = (sale.creditsGranted * (sale.refundedAmount + amount)) / sale.totalAmount;
    const creditDelta = targetCredits - sale.creditsReversed;
    if ((sale.tenant.creditAccount?.availableCreditMicros || 0n) < creditDelta) throw new AppError('REFUND_CREDITS_CONSUMED', 'Purchased credits have already been consumed; explicit resolution is required', { status: 409, details: { requiredCreditMicros: creditDelta.toString() } });
    return { sale, amount, creditDelta };
  }

  async applyRefund(eventId, refund) {
    return this.prisma.$transaction(async (db) => {
      const saleId = refund.metadata?.saleId;
      const paymentIntentId = customerId(refund.payment_intent);
      const sale = saleId ? await db.creditSale.findUnique({ where: { id: saleId } }) : await db.creditSale.findUnique({ where: { processorPaymentIntentId: paymentIntentId } });
      if (!sale) {
        await db.paymentEvent.update({ where: { id: eventId }, data: { status: 'ignored', processedAt: new Date() } });
        return null;
      }
      const amount = BigInt(refund.amount || 0);
      const nextRefunded = sale.refundedAmount + amount > sale.totalAmount ? sale.totalAmount : sale.refundedAmount + amount;
      const targetCredits = (sale.creditsGranted * nextRefunded) / sale.totalAmount;
      const creditDelta = targetCredits - sale.creditsReversed;
      const account = await db.creditAccount.findUnique({ where: { tenantId: sale.tenantId } });
      let resolutionRequired = creditDelta > 0n && (!account || account.availableCreditMicros < creditDelta);
      if (creditDelta > 0n && !resolutionRequired) {
        const after = await db.creditAccount.update({ where: { id: account.id }, data: { availableCreditMicros: { decrement: creditDelta } } });
        await db.creditLedgerEntry.create({ data: {
          id: crypto.randomUUID(), accountId: account.id, tenantId: sale.tenantId, userId: sale.customerUserId, saleId: sale.id,
          type: 'purchase_refund', availableDeltaCreditMicros: -creditDelta, reservedDeltaCreditMicros: 0n,
          availableAfterCreditMicros: after.availableCreditMicros, reservedAfterCreditMicros: after.reservedCreditMicros,
          idempotencyKey: `purchase-refund:${refund.id}`, metadata: { processorRefundId: refund.id, amount: amount.toString() },
        } });
      }
      const status = nextRefunded >= sale.totalAmount ? 'refunded' : 'partially_refunded';
      const updated = await db.creditSale.update({ where: { id: sale.id }, data: {
        status, refundedAmount: nextRefunded, creditsReversed: resolutionRequired ? sale.creditsReversed : targetCredits,
        refundResolutionRequired: resolutionRequired, refundedAt: status === 'refunded' ? new Date() : null,
      } });
      await db.paymentEvent.update({ where: { id: eventId }, data: { saleId: sale.id, status: 'processed', processedAt: new Date(), error: resolutionRequired ? 'Credit reversal requires explicit resolution' : null } });
      return updated;
    });
  }

  listPurchases({ tenantId, userId, limit = 100 }) {
    return this.prisma.creditSale.findMany({ where: { tenantId, customerUserId: userId, processor: 'stripe' }, include: { creditPack: true }, orderBy: { createdAt: 'desc' }, take: Math.min(200, Math.max(1, Number(limit) || 100)) });
  }

  async purchaseStatus({ saleId, tenantId, userId }) {
    const sale = await this.prisma.creditSale.findFirst({ where: { id: saleId, tenantId, customerUserId: userId }, include: { creditPack: true, checkoutAttempts: { orderBy: { createdAt: 'desc' }, take: 1 } } });
    if (!sale) throw new AppError('PURCHASE_NOT_FOUND', 'Purchase not found', { status: 404 });
    return sale;
  }

  account(tenantId) { return this.prisma.creditAccount.findUnique({ where: { tenantId } }); }
}

module.exports = { PrismaPaymentRepository };
