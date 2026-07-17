const crypto = require('node:crypto');
const { Prisma } = require('../../dist/generated/prisma/client.js');
const { AppError } = require('../errors');

class PrismaIdempotencyRepository {
  constructor(prisma) {
    this.prisma = prisma;
    this.ready = this.prisma.idempotencyRecord.updateMany({ where: { status: 'active' }, data: { status: 'interrupted', finishedAt: new Date() } });
  }
  payloadHash(body) { return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex'); }

  map(record) {
    return record && {
      ...record,
      body: record.responseBody,
      createdAt: record.createdAt.toISOString(),
      finishedAt: record.finishedAt?.toISOString(),
    };
  }

  async begin(projectId, key, body, { tenantId, userId } = {}) {
    await this.ready;
    const payloadHash = this.payloadHash(body);
    const existing = await this.prisma.idempotencyRecord.findUnique({ where: { projectId_key: { projectId, key } } });
    if (existing && existing.payloadHash !== payloadHash) throw new AppError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with a different request', { status: 409 });
    if (existing?.status === 'completed' || existing?.status === 'active') return { reused: true, record: this.map(existing) };
    if (existing) {
      const record = await this.prisma.idempotencyRecord.update({
        where: { id: existing.id },
        data: { status: 'active', jobId: null, statusCode: null, responseBody: Prisma.DbNull, finishedAt: null },
      });
      return { reused: false, record: this.map(record) };
    }
    try {
      const record = await this.prisma.idempotencyRecord.create({
        data: { id: crypto.randomUUID(), projectId, tenantId, userId, key, payloadHash, status: 'active' },
      });
      return { reused: false, record: this.map(record) };
    } catch (cause) {
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2002') return this.begin(projectId, key, body, { tenantId, userId });
      throw cause;
    }
  }

  async attach(projectId, key, jobId) { await this.prisma.idempotencyRecord.updateMany({ where: { projectId, key }, data: { jobId } }); }
  async complete(projectId, key, statusCode, body) { await this.prisma.idempotencyRecord.updateMany({ where: { projectId, key }, data: { status: 'completed', statusCode, responseBody: body, finishedAt: new Date() } }); }
  async fail(projectId, key) { await this.prisma.idempotencyRecord.deleteMany({ where: { projectId, key, status: 'active' } }); }
}

module.exports = { PrismaIdempotencyRepository };
