const crypto = require('node:crypto');
const { AppError } = require('../errors');

function json(value) { return value == null ? undefined : JSON.parse(JSON.stringify(value)); }

class PrismaBillingRepository {
  constructor(prisma) { this.prisma = prisma; }

  findActivePrice({ provider, modality, model }) {
    return this.prisma.providerPriceVersion.findFirst({ where: { provider, modality, model, active: true }, orderBy: { effectiveAt: 'desc' } });
  }

  activeMarkup() { return this.prisma.markupPolicyVersion.findFirst({ where: { active: true }, orderBy: { effectiveAt: 'desc' } }); }
  activeCreditRate() { return this.prisma.siteCreditRateVersion.findFirst({ where: { active: true }, orderBy: { effectiveAt: 'desc' } }); }

  async createMonitoringReservation(data) {
    return this.prisma.creditReservation.upsert({
      where: { generationRequestId: data.generationRequestId }, update: {},
      create: { id: crypto.randomUUID(), ...data, reservedCreditMicros: 0n, status: 'monitoring' },
    });
  }

  async createLiveReservation(data) {
    return this.prisma.$transaction(async (db) => {
      const existing = await db.creditReservation.findUnique({ where: { generationRequestId: data.generationRequestId } });
      if (existing) return existing;
      let account = await db.creditAccount.upsert({
        where: { tenantId: data.tenantId }, update: {},
        create: { id: crypto.randomUUID(), tenantId: data.tenantId, availableCreditMicros: 0n, reservedCreditMicros: 0n },
      });
      const amount = data.quotedCreditMicros;
      if (!account.chargingEnabled) {
        return db.creditReservation.create({ data: {
          id: crypto.randomUUID(), ...data, chargingMode: 'tenant_charging_disabled',
          reservedCreditMicros: 0n, status: 'monitoring',
        } });
      }
      const moved = await db.creditAccount.updateMany({
        where: { id: account.id, chargingEnabled: true, availableCreditMicros: { gte: amount } },
        data: { availableCreditMicros: { decrement: amount }, reservedCreditMicros: { increment: amount } },
      });
      if (!moved.count) throw new AppError('INSUFFICIENT_CREDITS', 'Insufficient site credits for this generation', { status: 402, details: { requiredCreditMicros: amount.toString() } });
      account = await db.creditAccount.findUnique({ where: { id: account.id } });
      const reservation = await db.creditReservation.create({ data: {
        id: crypto.randomUUID(), ...data, chargingMode: 'live', status: 'reserved', reservedCreditMicros: amount,
      } });
      await db.creditLedgerEntry.create({ data: {
        id: crypto.randomUUID(), accountId: account.id, tenantId: data.tenantId, userId: data.userId,
        reservationId: reservation.id, generationRequestId: data.generationRequestId, type: 'reservation',
        availableDeltaCreditMicros: -amount, reservedDeltaCreditMicros: amount,
        availableAfterCreditMicros: account.availableCreditMicros, reservedAfterCreditMicros: account.reservedCreditMicros,
        idempotencyKey: `reservation:${reservation.id}`, metadata: { quotedCreditMicros: amount.toString() },
      } });
      return reservation;
    }, { isolationLevel: 'Serializable' });
  }

  async settle({ reservationId, generationRequestId, usageEventId, price, usage, providerCostNanoUsd, calculation, customerNanoUsd, finalCreditMicros }) {
    return this.prisma.$transaction(async (db) => {
      let reservation = await db.creditReservation.findUnique({ where: { id: reservationId } });
      if (!reservation) throw new Error('Billing reservation not found');
      if (['settled', 'settled_not_charged'].includes(reservation.status)) return reservation;
      let snapshot = await db.providerCostSnapshot.findUnique({ where: { generationRequestId } });
      if (!snapshot) snapshot = await db.providerCostSnapshot.create({ data: {
        id: crypto.randomUUID(), generationRequestId, usageEventId, providerPriceVersionId: price.id,
        usageSnapshot: json(usage), rateCardSnapshot: json(price.rateCard), providerCostNanoUsd,
        currency: price.currency, calculation: json(calculation),
      } });

      const final = { providerCostSnapshotId: snapshot.id, finalProviderNanoUsd: providerCostNanoUsd, finalCustomerNanoUsd: customerNanoUsd, finalCreditMicros, settledAt: new Date() };
      if (reservation.chargingMode !== 'live') {
        return db.creditReservation.update({ where: { id: reservation.id }, data: { ...final, status: 'settled_not_charged' } });
      }

      const reserved = reservation.reservedCreditMicros;
      const extra = finalCreditMicros > reserved ? finalCreditMicros - reserved : 0n;
      const refund = reserved > finalCreditMicros ? reserved - finalCreditMicros : 0n;
      const account = await db.creditAccount.findUnique({ where: { tenantId: reservation.tenantId } });
      reservation = await db.creditReservation.update({ where: { id: reservation.id }, data: { ...final, status: 'settled' } });
      const settlementReserved = refund ? finalCreditMicros : reserved;
      const moved = await db.creditAccount.updateMany({
        where: { id: account.id, reservedCreditMicros: { gte: reserved }, ...(extra ? { availableCreditMicros: { gte: extra } } : {}) },
        data: { ...(extra ? { availableCreditMicros: { decrement: extra } } : {}), reservedCreditMicros: { decrement: settlementReserved } },
      });
      if (!moved.count) throw new AppError('CREDIT_SETTLEMENT_FAILED', 'Reserved credits could not be settled', { status: 409 });
      let after = await db.creditAccount.findUnique({ where: { id: account.id } });
      await db.creditLedgerEntry.create({ data: {
        id: crypto.randomUUID(), accountId: account.id, tenantId: reservation.tenantId, userId: reservation.userId,
        reservationId: reservation.id, generationRequestId, type: 'settlement',
        availableDeltaCreditMicros: -extra, reservedDeltaCreditMicros: -settlementReserved,
        availableAfterCreditMicros: after.availableCreditMicros, reservedAfterCreditMicros: after.reservedCreditMicros,
        idempotencyKey: `settlement:${reservation.id}`, metadata: { finalCreditMicros: finalCreditMicros.toString(), providerCostNanoUsd: providerCostNanoUsd.toString() },
      } });
      if (refund) {
        after = await db.creditAccount.update({ where: { id: account.id }, data: { availableCreditMicros: { increment: refund }, reservedCreditMicros: { decrement: refund } } });
        await db.creditLedgerEntry.create({ data: {
          id: crypto.randomUUID(), accountId: account.id, tenantId: reservation.tenantId, userId: reservation.userId,
          reservationId: reservation.id, generationRequestId, type: 'refund',
          availableDeltaCreditMicros: refund, reservedDeltaCreditMicros: -refund,
          availableAfterCreditMicros: after.availableCreditMicros, reservedAfterCreditMicros: after.reservedCreditMicros,
          idempotencyKey: `refund:${reservation.id}`, metadata: { reason: 'unused_reservation', creditMicros: refund.toString() },
        } });
      }
      return reservation;
    }, { isolationLevel: 'Serializable' });
  }

  async release(generationRequestId, reason) {
    return this.prisma.$transaction(async (db) => {
      let reservation = await db.creditReservation.findUnique({ where: { generationRequestId } });
      if (!reservation || ['released', 'failed_not_charged', 'settled', 'settled_not_charged'].includes(reservation.status)) return reservation;
      if (reservation.chargingMode !== 'live') return db.creditReservation.update({ where: { id: reservation.id }, data: { status: 'failed_not_charged', failureReason: String(reason || 'provider_failed').slice(0, 500), settledAt: new Date() } });
      const account = await db.creditAccount.findUnique({ where: { tenantId: reservation.tenantId } });
      const amount = reservation.reservedCreditMicros;
      const moved = await db.creditAccount.updateMany({ where: { id: account.id, reservedCreditMicros: { gte: amount } }, data: { availableCreditMicros: { increment: amount }, reservedCreditMicros: { decrement: amount } } });
      if (!moved.count) throw new AppError('CREDIT_RELEASE_FAILED', 'Reserved credits could not be released', { status: 409 });
      const after = await db.creditAccount.findUnique({ where: { id: account.id } });
      reservation = await db.creditReservation.update({ where: { id: reservation.id }, data: { status: 'released', failureReason: String(reason || 'provider_failed').slice(0, 500), settledAt: new Date() } });
      await db.creditLedgerEntry.create({ data: {
        id: crypto.randomUUID(), accountId: account.id, tenantId: reservation.tenantId, userId: reservation.userId,
        reservationId: reservation.id, generationRequestId, type: 'release', availableDeltaCreditMicros: amount,
        reservedDeltaCreditMicros: -amount, availableAfterCreditMicros: after.availableCreditMicros,
        reservedAfterCreditMicros: after.reservedCreditMicros, idempotencyKey: `release:${reservation.id}`,
        metadata: { reason: reservation.failureReason },
      } });
      return reservation;
    }, { isolationLevel: 'Serializable' });
  }

  async completeWithoutCost(generationRequestId, reason = 'no_active_price') {
    return this.prisma.creditReservation.updateMany({
      where: { generationRequestId, status: 'monitoring' },
      data: { status: 'completed_without_cost', failureReason: reason, settledAt: new Date() },
    });
  }

  async markSettlementPending(generationRequestId, error) {
    return this.prisma.creditReservation.updateMany({
      where: { generationRequestId, status: { in: ['reserved', 'monitoring'] } },
      data: { status: 'settlement_pending', failureReason: String(error?.message || error || 'settlement_failed').slice(0, 500) },
    });
  }

  async grant({ tenantId, userId = null, creditMicros, idempotencyKey, metadata }) {
    return this.prisma.$transaction(async (db) => {
      const prior = await db.creditLedgerEntry.findUnique({ where: { idempotencyKey } });
      if (prior) return prior;
      let account = await db.creditAccount.upsert({ where: { tenantId }, update: {}, create: { id: crypto.randomUUID(), tenantId } });
      account = await db.creditAccount.update({ where: { id: account.id }, data: { availableCreditMicros: { increment: creditMicros } } });
      return db.creditLedgerEntry.create({ data: {
        id: crypto.randomUUID(), accountId: account.id, tenantId, userId, type: 'grant',
        availableDeltaCreditMicros: creditMicros, reservedDeltaCreditMicros: 0n,
        availableAfterCreditMicros: account.availableCreditMicros, reservedAfterCreditMicros: account.reservedCreditMicros,
        idempotencyKey, metadata: json(metadata),
      } });
    }, { isolationLevel: 'Serializable' });
  }

  async setChargingEnabled({ tenantId, enabled, actorUserId, idempotencyKey }) {
    return this.prisma.$transaction(async (db) => {
      const prior = await db.creditLedgerEntry.findUnique({ where: { idempotencyKey } });
      if (prior) return { account: await db.creditAccount.findUnique({ where: { tenantId } }), entry: prior, reused: true };
      let account = await db.creditAccount.upsert({ where: { tenantId }, update: {}, create: { id: crypto.randomUUID(), tenantId } });
      if (account.chargingEnabled === enabled) return { account, entry: null, reused: false, unchanged: true };
      account = await db.creditAccount.update({ where: { id: account.id }, data: {
        chargingEnabled: enabled, chargingChangedAt: new Date(), chargingChangedByUserId: actorUserId,
      } });
      const entry = await db.creditLedgerEntry.create({ data: {
        id: crypto.randomUUID(), accountId: account.id, tenantId, userId: actorUserId,
        type: enabled ? 'charging_enabled' : 'charging_disabled',
        availableDeltaCreditMicros: 0n, reservedDeltaCreditMicros: 0n,
        availableAfterCreditMicros: account.availableCreditMicros, reservedAfterCreditMicros: account.reservedCreditMicros,
        idempotencyKey, metadata: { chargingEnabled: enabled },
      } });
      return { account, entry, reused: false, unchanged: false };
    }, { isolationLevel: 'Serializable' });
  }

  listPrices() { return this.prisma.providerPriceVersion.findMany({ orderBy: [{ provider: 'asc' }, { modality: 'asc' }, { model: 'asc' }, { effectiveAt: 'desc' }] }); }
  listMarkups() { return this.prisma.markupPolicyVersion.findMany({ orderBy: { effectiveAt: 'desc' } }); }
  listCreditRates() { return this.prisma.siteCreditRateVersion.findMany({ orderBy: { effectiveAt: 'desc' } }); }
  listWelcomeCreditPolicies() { return this.prisma.welcomeCreditPolicyVersion.findMany({ orderBy: { effectiveAt: 'desc' } }); }
  listAccounts() { return this.prisma.creditAccount.findMany({ include: { tenant: { select: { name: true } } }, orderBy: { updatedAt: 'desc' } }); }
  listLedger({ tenantId, limit = 100 } = {}) { return this.prisma.creditLedgerEntry.findMany({ where: tenantId ? { tenantId } : {}, orderBy: { createdAt: 'desc' }, take: Math.min(500, Math.max(1, Number(limit) || 100)) }); }
  listMargins({ tenantId, limit = 100 } = {}) {
    return this.prisma.creditReservation.findMany({
      where: { ...(tenantId ? { tenantId } : {}), providerCostSnapshotId: { not: null } },
      include: { providerCostSnapshot: true, providerPriceVersion: true, markupPolicyVersion: true, siteCreditRateVersion: true },
      orderBy: { settledAt: 'desc' }, take: Math.min(500, Math.max(1, Number(limit) || 100)),
    });
  }

  createPriceVersion(data) {
    if (data.billable && (data.evidenceStatus !== 'dashboard_reconciled' || !data.reconciledAt)) throw new AppError('PRICE_NOT_RECONCILED', 'A provider price must have dated dashboard reconciliation before it can be billable', { status: 409 });
    return this.prisma.providerPriceVersion.create({ data: { id: crypto.randomUUID(), ...data } });
  }
  createMarkupVersion(data) { return this.prisma.markupPolicyVersion.create({ data: { id: crypto.randomUUID(), ...data } }); }
  createCreditRateVersion(data) { return this.prisma.siteCreditRateVersion.create({ data: { id: crypto.randomUUID(), ...data } }); }

  async createWelcomeCreditPolicyVersion(data) {
    return this.prisma.$transaction(async (db) => {
      if (data.active) await db.welcomeCreditPolicyVersion.updateMany({ where: { active: true }, data: { active: false, retiredAt: new Date() } });
      return db.welcomeCreditPolicyVersion.create({ data: { id: crypto.randomUUID(), ...data } });
    }, { isolationLevel: 'Serializable' });
  }

  async configurePrice(id, { active, billable, evidenceStatus, reconciledAt, reconciliationNotes }) {
    return this.prisma.$transaction(async (db) => {
      const current = await db.providerPriceVersion.findUnique({ where: { id } });
      if (!current) throw new AppError('PRICE_VERSION_NOT_FOUND', 'Provider price version not found', { status: 404 });
      const nextEvidence = evidenceStatus || current.evidenceStatus;
      const nextReconciledAt = reconciledAt === undefined ? current.reconciledAt : reconciledAt;
      const nextBillable = billable == null ? current.billable : billable;
      if (nextBillable && (nextEvidence !== 'dashboard_reconciled' || !nextReconciledAt)) throw new AppError('PRICE_NOT_RECONCILED', 'A provider price must have dated dashboard reconciliation before it can be billable', { status: 409 });
      if (active === true) await db.providerPriceVersion.updateMany({ where: { provider: current.provider, modality: current.modality, model: current.model, active: true, id: { not: id } }, data: { active: false, retiredAt: new Date() } });
      return db.providerPriceVersion.update({ where: { id }, data: {
        ...(active == null ? {} : { active, retiredAt: active ? null : new Date() }),
        ...(billable == null ? {} : { billable }), ...(evidenceStatus ? { evidenceStatus } : {}),
        ...(reconciledAt !== undefined ? { reconciledAt } : {}),
        ...(reconciliationNotes !== undefined ? { reconciliationNotes } : {}),
      } });
    }, { isolationLevel: 'Serializable' });
  }

  async activateMarkup(id) {
    return this.prisma.$transaction(async (db) => {
      await db.markupPolicyVersion.updateMany({ where: { active: true, id: { not: id } }, data: { active: false, retiredAt: new Date() } });
      return db.markupPolicyVersion.update({ where: { id }, data: { active: true, retiredAt: null } });
    });
  }

  async activateCreditRate(id) {
    return this.prisma.$transaction(async (db) => {
      await db.siteCreditRateVersion.updateMany({ where: { active: true, id: { not: id } }, data: { active: false, retiredAt: new Date() } });
      return db.siteCreditRateVersion.update({ where: { id }, data: { active: true, retiredAt: null } });
    });
  }
}

module.exports = { PrismaBillingRepository };
