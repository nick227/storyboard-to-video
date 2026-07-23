const crypto = require('node:crypto');
const { Prisma } = require('../../dist/generated/prisma/client.js');
const { AppError } = require('../errors');
const { ScriptStore } = require('./script-store');
const { slugify, cleanText } = require('../shared/text');

class PrismaScriptRepository extends ScriptStore {
  constructor(prisma) {
    super();
    this.prisma = prisma;
  }

  map(row) {
    if (!row) return null;
    return {
      id: row.id,
      tenantId: row.tenantId,
      createdByUserId: row.createdByUserId,
      title: row.title,
      slug: row.slug,
      visibility: row.visibility,
      author: row.author,
      scriptText: row.scriptText,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async create(input = {}, { tenantId, createdByUserId } = {}) {
    const id = input.id || crypto.randomUUID();
    const slug = await this.allocateSlug(input.slug || input.title || 'untitled', { excludeId: id });
    const visibility = input.visibility === 'public' ? 'public' : 'private';
    const now = new Date();
    try {
      const row = await this.prisma.script.create({
        data: {
          id,
          tenantId,
          createdByUserId,
          title: cleanText(input.title || 'Untitled', 200) || 'Untitled',
          slug,
          visibility,
          author: cleanText(input.author || 'Anonymous', 200) || 'Anonymous',
          scriptText: String(input.scriptText || ''),
          publishedAt: visibility === 'public' ? (input.publishedAt ? new Date(input.publishedAt) : now) : null,
          createdAt: now,
          updatedAt: now,
        },
      });
      return this.map(row);
    } catch (cause) {
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2002') {
        throw new AppError('SCRIPT_SLUG_EXISTS', 'Script slug already exists', { status: 409 });
      }
      throw cause;
    }
  }

  async read(id, { tenantId } = {}) {
    const row = await this.prisma.script.findUnique({ where: { id } });
    if (!row || (tenantId && row.tenantId !== tenantId)) {
      throw new AppError('SCRIPT_NOT_FOUND', 'Script not found', { status: 404 });
    }
    return this.map(row);
  }

  async update(id, patch = {}, { tenantId } = {}) {
    const existing = await this.read(id, { tenantId });
    const data = { updatedAt: new Date() };
    if (patch.title != null) data.title = cleanText(patch.title, 200) || 'Untitled';
    if (patch.author != null) data.author = cleanText(patch.author, 200) || 'Anonymous';
    if (patch.scriptText != null) data.scriptText = String(patch.scriptText);
    if (patch.slug != null) data.slug = await this.allocateSlug(patch.slug, { excludeId: id });
    if (patch.visibility === 'public') {
      data.visibility = 'public';
      data.publishedAt = existing.publishedAt ? new Date(existing.publishedAt) : new Date();
    } else if (patch.visibility === 'private') {
      data.visibility = 'private';
      data.publishedAt = null;
    }
    try {
      const row = await this.prisma.script.update({ where: { id }, data });
      return this.map(row);
    } catch (cause) {
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2002') {
        throw new AppError('SCRIPT_SLUG_EXISTS', 'Script slug already exists', { status: 409 });
      }
      throw cause;
    }
  }

  async list({ tenantId } = {}) {
    const rows = await this.prisma.script.findMany({
      where: tenantId ? { tenantId } : {},
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map((row) => this.map(row));
  }

  async listPublic({ limit = 50, offset = 0 } = {}) {
    const rows = await this.prisma.script.findMany({
      where: { visibility: 'public' },
      orderBy: [{ publishedAt: 'desc' }, { updatedAt: 'desc' }],
      take: Math.min(100, Math.max(1, Number(limit) || 50)),
      skip: Math.max(0, Number(offset) || 0),
    });
    return rows.map((row) => this.map(row));
  }

  async findBySlug(slug) {
    const row = await this.prisma.script.findUnique({ where: { slug: String(slug || '') } });
    return this.map(row);
  }

  async allocateSlug(raw, { excludeId } = {}) {
    const base = slugify(raw).slice(0, 80) || 'untitled';
    let candidate = base;
    let attempt = 0;
    while (true) {
      const existing = await this.prisma.script.findUnique({ where: { slug: candidate } });
      if (!existing || existing.id === excludeId) return candidate;
      attempt += 1;
      candidate = `${base.slice(0, 60)}-${attempt}`;
    }
  }

  async linkProject(projectId, scriptId, { tenantId } = {}) {
    const result = await this.prisma.project.updateMany({
      where: { id: projectId, ...(tenantId ? { tenantId } : {}) },
      data: { scriptId },
    });
    if (!result.count) throw new AppError('PROJECT_NOT_FOUND', 'Project not found', { status: 404 });
  }
}

module.exports = { PrismaScriptRepository };
