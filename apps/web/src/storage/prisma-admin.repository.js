const crypto = require('node:crypto');
const { AppError } = require('../errors');
const { json, serializable } = require('./prisma-shared');

function publicUser(user) { return user && { id: user.id, email: user.email, displayName: user.displayName, status: user.status, platformRole: user.platformRole }; }

class PrismaAdminRepository {
  constructor(prisma) { this.prisma = prisma; }

  audit(db, { actorUserId, tenantId = null, action, targetType, targetId, reason = null, before, after, requestId = null }) {
    return db.adminAuditEvent.create({ data: { id: crypto.randomUUID(), actorUserId, tenantId, action, targetType, targetId: String(targetId), reason, before: json(before), after: json(after), requestId } });
  }

  recordAudit(event) { return this.audit(this.prisma, event); }

  async listUsers({ search, status, role, limit = 100 } = {}) {
    const take = Math.min(500, Math.max(1, Number(limit) || 100));
    return this.prisma.user.findMany({
      where: {
        ...(search ? { OR: [{ email: { contains: search, mode: 'insensitive' } }, { displayName: { contains: search, mode: 'insensitive' } }] } : {}),
        ...(status ? { status } : {}), ...(role ? { platformRole: role } : {}),
      },
      select: {
        id: true, email: true, displayName: true, status: true, platformRole: true, createdAt: true, updatedAt: true,
        memberships: { select: { role: true, workspace: { select: { id: true, name: true, type: true, creditAccount: true } } }, orderBy: { createdAt: 'asc' } },
        _count: { select: { generationRequests: true, sessions: true } },
      },
      orderBy: { createdAt: 'desc' }, take,
    });
  }

  async setUserStatus({ userId, status, actorUserId, reason, requestId }) {
    if (userId === actorUserId && status !== 'active') throw new AppError('SELF_DISABLE_FORBIDDEN', 'You cannot disable your own account', { status: 409 });
    return this.prisma.$transaction(async (db) => {
      const current = await db.user.findUnique({ where: { id: userId } });
      if (!current) throw new AppError('USER_NOT_FOUND', 'User not found', { status: 404 });
      if (current.status === status) return publicUser(current);
      const updated = await db.user.update({ where: { id: userId }, data: { status } });
      if (status !== 'active') await db.session.deleteMany({ where: { userId } });
      await this.audit(db, { actorUserId, action: status === 'active' ? 'user.enabled' : 'user.disabled', targetType: 'user', targetId: userId, reason, before: publicUser(current), after: publicUser(updated), requestId });
      return publicUser(updated);
    });
  }

  async setPlatformRole({ userId, platformRole, actorUserId, actorRole, reason, requestId }) {
    if (platformRole === 'super_admin' && actorRole !== 'super_admin') throw new AppError('SUPER_ADMIN_REQUIRED', 'Only a super administrator can grant that role', { status: 403 });
    if (userId === actorUserId && platformRole !== actorRole) throw new AppError('SELF_ROLE_CHANGE_FORBIDDEN', 'You cannot change your own platform role', { status: 409 });
    return this.prisma.$transaction(async (db) => {
      const current = await db.user.findUnique({ where: { id: userId } });
      if (!current) throw new AppError('USER_NOT_FOUND', 'User not found', { status: 404 });
      if (current.platformRole === 'super_admin' && platformRole !== 'super_admin') {
        const remaining = await db.user.count({ where: { platformRole: 'super_admin', status: 'active', id: { not: userId } } });
        if (!remaining) throw new AppError('LAST_SUPER_ADMIN', 'The final active super administrator cannot be demoted', { status: 409 });
      }
      if (current.platformRole === platformRole) return publicUser(current);
      const updated = await db.user.update({ where: { id: userId }, data: { platformRole } });
      await this.audit(db, { actorUserId, action: 'user.role_changed', targetType: 'user', targetId: userId, reason, before: publicUser(current), after: publicUser(updated), requestId });
      return publicUser(updated);
    });
  }

  async recordSale({ tenantId, customerUserId, cashAmountNanoUsd, creditsPurchasedMicros, currency, paymentProvider, externalPaymentId, occurredAt, notes, actorUserId, idempotencyKey, requestId }) {
    return serializable(this.prisma, async (db) => {
      const priorLedger = await db.creditLedgerEntry.findUnique({ where: { idempotencyKey } });
      if (priorLedger) {
        const sale = await db.creditSale.findUnique({ where: { creditLedgerEntryId: priorLedger.id } });
        if (sale) return { sale, ledgerEntry: priorLedger, reused: true };
        throw new AppError('IDEMPOTENCY_CONFLICT', 'That idempotency key belongs to another credit action', { status: 409 });
      }
      if (externalPaymentId) {
        const priorSale = await db.creditSale.findUnique({ where: { externalPaymentId } });
        if (priorSale) return { sale: priorSale, ledgerEntry: await db.creditLedgerEntry.findUnique({ where: { id: priorSale.creditLedgerEntryId } }), reused: true };
      }
      const membership = await db.membership.findUnique({ where: { userId_tenantId: { userId: customerUserId, tenantId } } });
      if (!membership) throw new AppError('CUSTOMER_TENANT_MISMATCH', 'Customer is not a member of that tenant', { status: 409 });
      let account = await db.creditAccount.upsert({ where: { tenantId }, update: {}, create: { id: crypto.randomUUID(), tenantId } });
      account = await db.creditAccount.update({ where: { id: account.id }, data: { availableCreditMicros: { increment: creditsPurchasedMicros } } });
      const ledgerEntry = await db.creditLedgerEntry.create({ data: {
        id: crypto.randomUUID(), accountId: account.id, tenantId, userId: customerUserId, type: 'sale_grant',
        availableDeltaCreditMicros: creditsPurchasedMicros, reservedDeltaCreditMicros: 0n,
        availableAfterCreditMicros: account.availableCreditMicros, reservedAfterCreditMicros: account.reservedCreditMicros,
        idempotencyKey, metadata: { cashAmountNanoUsd: cashAmountNanoUsd.toString(), currency, paymentProvider, externalPaymentId: externalPaymentId || null },
      } });
      const sale = await db.creditSale.create({ data: {
        id: crypto.randomUUID(), tenantId, customerUserId, cashAmountNanoUsd, creditsPurchasedMicros, currency,
        creditsGranted: creditsPurchasedMicros, paymentProvider, processor: paymentProvider,
        externalPaymentId: externalPaymentId || null, subtotalAmount: (cashAmountNanoUsd + 9999999n) / 10000000n,
        totalAmount: (cashAmountNanoUsd + 9999999n) / 10000000n, status: 'credits_funded', paidAt: occurredAt,
        creditLedgerEntryId: ledgerEntry.id, recordedByAdminId: actorUserId, notes: notes || null, occurredAt,
      } });
      await this.audit(db, { actorUserId, tenantId, action: 'sale.recorded', targetType: 'credit_sale', targetId: sale.id, reason: notes, after: { saleId: sale.id, cashAmountNanoUsd: cashAmountNanoUsd.toString(), creditsPurchasedMicros: creditsPurchasedMicros.toString(), customerUserId }, requestId });
      return { sale, ledgerEntry, reused: false };
    });
  }

  listSales({ tenantId, limit = 100 } = {}) {
    return this.prisma.creditSale.findMany({ where: tenantId ? { tenantId } : {}, include: { customerUser: { select: { email: true, displayName: true } }, tenant: { select: { name: true } }, recordedByAdmin: { select: { email: true, displayName: true } } }, orderBy: { occurredAt: 'desc' }, take: Math.min(500, Math.max(1, Number(limit) || 100)) });
  }

  async overview({ startAt, endAt } = {}) {
    const range = { ...(startAt ? { gte: startAt } : {}), ...(endAt ? { lt: endAt } : {}) };
    const fundedStatuses = ['credits_funded', 'partially_refunded', 'refunded', 'disputed'];
    const saleWhere = Object.keys(range).length ? { occurredAt: range, status: { in: fundedStatuses } } : { status: { in: fundedStatuses } };
    const requestWhere = Object.keys(range).length ? { startedAt: range } : {};
    const reservationWhere = Object.keys(range).length ? { createdAt: range, providerCostSnapshotId: { not: null } } : { providerCostSnapshotId: { not: null } };
    const [sales, saleMoney, accounts, requestsByStatus, requestsByType, reservations] = await Promise.all([
      this.prisma.creditSale.aggregate({ where: saleWhere, _sum: { cashAmountNanoUsd: true, creditsPurchasedMicros: true }, _count: true }),
      this.prisma.creditSale.findMany({ where: saleWhere, select: { processor: true, cashAmountNanoUsd: true, totalAmount: true, refundedAmount: true } }),
      this.prisma.creditAccount.aggregate({ _sum: { availableCreditMicros: true, reservedCreditMicros: true } }),
      this.prisma.generationRequest.groupBy({ by: ['status'], where: requestWhere, _count: true }),
      this.prisma.generationRequest.groupBy({ by: ['modality'], where: requestWhere, _count: true }),
      this.prisma.creditReservation.findMany({ where: reservationWhere, select: { status: true, finalCustomerNanoUsd: true, providerCostSnapshot: { select: { providerCostNanoUsd: true } } } }),
    ]);
    let providerCostNanoUsd = 0n; let nominalChargeNanoUsd = 0n; let negativeMarginCount = 0; let settlementPendingCount = 0;
    for (const row of reservations) {
      if (row.status === 'settlement_pending') settlementPendingCount += 1;
      const cost = row.providerCostSnapshot?.providerCostNanoUsd || 0n;
      const charge = row.finalCustomerNanoUsd || 0n;
      providerCostNanoUsd += cost; nominalChargeNanoUsd += charge;
      if (charge < cost) negativeMarginCount += 1;
    }
    const netSalesNanoUsd = saleMoney.reduce((sum, sale) => sum + (sale.processor === 'stripe' ? (sale.totalAmount - sale.refundedAmount) * 10000000n : sale.cashAmountNanoUsd), 0n);
    return { sales, netSalesNanoUsd, accounts, requestsByStatus, requestsByType, providerCostNanoUsd, nominalChargeNanoUsd, grossMarginNanoUsd: nominalChargeNanoUsd - providerCostNanoUsd, negativeMarginCount, settlementPendingCount };
  }

  async listGenerations({ tenantId, userId, modality, provider, status, limit = 100 } = {}) {
    const rows = await this.prisma.generationRequest.findMany({
      where: { ...(tenantId ? { tenantId } : {}), ...(userId ? { userId } : {}), ...(modality ? { modality } : {}), ...(provider ? { provider } : {}), ...(status ? { status } : {}) },
      include: {
        tenant: { select: { name: true } }, user: { select: { email: true, displayName: true } }, usageEvent: true,
        costSnapshot: true, creditReservation: { include: { markupPolicyVersion: true, siteCreditRateVersion: true, providerPriceVersion: true } },
      }, orderBy: { startedAt: 'desc' }, take: Math.min(500, Math.max(1, Number(limit) || 100)),
    });
    const jobIds = rows.map((row) => row.jobId).filter(Boolean);
    const jobs = jobIds.length ? await this.prisma.generationJob.findMany({ where: { id: { in: jobIds } } }) : [];
    const byId = new Map(jobs.map((job) => [job.id, job]));
    return rows.map((row) => ({ ...row, job: row.jobId ? byId.get(row.jobId) || null : null }));
  }

  listAudit({ limit = 100 } = {}) {
    return this.prisma.adminAuditEvent.findMany({ include: { actor: { select: { email: true, displayName: true } }, tenant: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: Math.min(500, Math.max(1, Number(limit) || 100)) });
  }
}

module.exports = { PrismaAdminRepository };
