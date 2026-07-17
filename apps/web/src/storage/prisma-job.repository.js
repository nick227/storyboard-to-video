const { Prisma } = require('../../dist/generated/prisma/client.js');

class PrismaJobRepository {
  constructor(prisma) { this.prisma = prisma; }

  data(job) {
    return {
      projectId: job.projectId || null,
      sceneId: job.sceneId || null,
      tenantId: job.tenantId || null,
      userId: job.userId || null,
      type: job.type,
      status: job.status,
      idempotencyKey: job.idempotencyKey || null,
      result: job.result ?? null,
      error: job.error ?? null,
      createdAt: new Date(job.createdAt),
      startedAt: job.startedAt ? new Date(job.startedAt) : null,
      finishedAt: job.finishedAt ? new Date(job.finishedAt) : null,
    };
  }

  async save(job) {
    const data = this.data(job);
    try {
      await this.prisma.generationJob.upsert({ where: { id: job.id }, create: { id: job.id, ...data }, update: data });
    } catch (cause) {
      if (!(cause instanceof Prisma.PrismaClientKnownRequestError) || cause.code !== 'P2003' || !data.projectId) throw cause;
      const detached = { ...data, projectId: null };
      job.projectId = null;
      await this.prisma.generationJob.upsert({ where: { id: job.id }, create: { id: job.id, ...detached }, update: detached });
    }
  }

  async loadAndInterrupt() {
    const now = new Date();
    await this.prisma.generationJob.updateMany({
      where: { status: { in: ['queued', 'running'] } },
      data: { status: 'interrupted', finishedAt: now, error: { code: 'SERVER_RESTARTED', message: 'Job was interrupted by a server restart' } },
    });
    const rows = await this.prisma.generationJob.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt?.toISOString(),
      finishedAt: row.finishedAt?.toISOString(),
    }));
  }

  async delete(id) { await this.prisma.generationJob.deleteMany({ where: { id } }); }
}

module.exports = { PrismaJobRepository };
