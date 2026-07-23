const crypto = require('node:crypto');
const { Prisma } = require('../../dist/generated/prisma/client.js');
const { AppError } = require('../errors');
const { ScriptStore } = require('./script-store');
const { slugify, cleanText } = require('../shared/text');

const SCRIPT_INCLUDE = {
  category: true,
  tags: { include: { tag: true } },
  createdBy: { select: { id: true, profileSlug: true, displayName: true } },
  _count: { select: { likes: true, views: true } },
};

class PrismaScriptRepository extends ScriptStore {
  constructor(prisma) {
    super();
    this.prisma = prisma;
  }

  map(row) {
    if (!row) return null;
    const tags = (row.tags || [])
      .map((st) => st.tag)
      .filter(Boolean)
      .map((t) => ({ id: t.id, slug: t.slug, name: t.name }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
    const writer = row.createdBy
      ? { id: row.createdBy.id, profileSlug: row.createdBy.profileSlug, displayName: row.createdBy.displayName }
      : row.writer || null;
    return {
      id: row.id,
      tenantId: row.tenantId,
      createdByUserId: row.createdByUserId,
      title: row.title,
      slug: row.slug,
      visibility: row.visibility,
      author: row.author,
      logline: row.logline || '',
      categoryId: row.categoryId || null,
      category: row.category ? { id: row.category.id, slug: row.category.slug, name: row.category.name } : null,
      tags,
      scriptText: row.scriptText,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString?.() || row.createdAt,
      updatedAt: row.updatedAt.toISOString?.() || row.updatedAt,
      likeCount: row._count?.likes ?? row.likeCount ?? 0,
      viewCount: row._count?.views ?? row.viewCount ?? 0,
      writer,
    };
  }

  async create(input = {}, { tenantId, createdByUserId } = {}) {
    const id = input.id || crypto.randomUUID();
    const slug = await this.allocateSlug(input.slug || input.title || 'untitled', { excludeId: id });
    const visibility = input.visibility === 'public' ? 'public' : 'private';
    const now = new Date();
    const tags = Array.isArray(input.tagSlugs) ? await this.ensureTags(input.tagSlugs) : [];
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
          logline: cleanText(input.logline || '', 280),
          categoryId: input.categoryId || null,
          scriptText: String(input.scriptText || ''),
          publishedAt: visibility === 'public' ? (input.publishedAt ? new Date(input.publishedAt) : now) : null,
          createdAt: now,
          updatedAt: now,
          ...(tags.length ? { tags: { create: tags.map((t) => ({ tagId: t.id })) } } : {}),
        },
        include: SCRIPT_INCLUDE,
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
    const row = await this.prisma.script.findUnique({ where: { id }, include: SCRIPT_INCLUDE });
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
    if (patch.logline != null) data.logline = cleanText(patch.logline, 280);
    if (patch.slug != null) data.slug = await this.allocateSlug(patch.slug, { excludeId: id });
    if (patch.categoryId !== undefined) data.categoryId = patch.categoryId || null;
    if (patch.visibility === 'public') {
      data.visibility = 'public';
      data.publishedAt = existing.publishedAt ? new Date(existing.publishedAt) : new Date();
    } else if (patch.visibility === 'private') {
      data.visibility = 'private';
      data.publishedAt = null;
    }
    try {
      if (Array.isArray(patch.tagSlugs)) {
        const tags = await this.ensureTags(patch.tagSlugs);
        await this.setScriptTags(id, tags.map((t) => t.id));
      }
      const row = await this.prisma.script.update({ where: { id }, data, include: SCRIPT_INCLUDE });
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
      include: SCRIPT_INCLUDE,
    });
    return rows.map((row) => this.map(row));
  }

  async listPublic({ limit = 50, offset = 0, createdByUserId, excludeId, categorySlug, tagSlug } = {}) {
    const rows = await this.prisma.script.findMany({
      where: {
        visibility: 'public',
        ...(createdByUserId ? { createdByUserId } : {}),
        ...(excludeId ? { id: { not: excludeId } } : {}),
        ...(categorySlug ? { category: { slug: categorySlug } } : {}),
        ...(tagSlug ? { tags: { some: { tag: { slug: tagSlug } } } } : {}),
      },
      orderBy: [{ publishedAt: 'desc' }, { updatedAt: 'desc' }],
      take: Math.min(100, Math.max(1, Number(limit) || 50)),
      skip: Math.max(0, Number(offset) || 0),
      include: SCRIPT_INCLUDE,
    });
    return rows.map((row) => this.map(row));
  }

  async findBySlug(slug) {
    const row = await this.prisma.script.findUnique({
      where: { slug: String(slug || '') },
      include: SCRIPT_INCLUDE,
    });
    return this.map(row);
  }

  async listCategories() {
    const rows = await this.prisma.category.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
    return rows.map((c) => ({ id: c.id, slug: c.slug, name: c.name, sortOrder: c.sortOrder }));
  }

  async findCategoryBySlug(slug) {
    return this.prisma.category.findUnique({ where: { slug: String(slug || '') } });
  }

  async ensureTags(slugs = []) {
    const out = [];
    for (const raw of slugs) {
      const slug = slugify(String(raw || '')).slice(0, 40);
      if (!slug) continue;
      const name = cleanText(String(raw), 40) || slug;
      const tag = await this.prisma.tag.upsert({
        where: { slug },
        update: {},
        create: { id: crypto.randomUUID(), slug, name },
      });
      out.push(tag);
    }
    return out;
  }

  async setScriptTags(scriptId, tagIds = []) {
    await this.prisma.$transaction([
      this.prisma.scriptTag.deleteMany({ where: { scriptId } }),
      ...(tagIds.length
        ? [this.prisma.scriptTag.createMany({ data: tagIds.map((tagId) => ({ scriptId, tagId })), skipDuplicates: true })]
        : []),
    ]);
  }

  async recordView(scriptId, viewerUserId = null) {
    await this.read(scriptId);
    await this.prisma.scriptView.create({
      data: { id: crypto.randomUUID(), scriptId, viewerUserId: viewerUserId || null },
    });
    const viewCount = await this.prisma.scriptView.count({ where: { scriptId } });
    return { viewCount };
  }

  async getStats(scriptId) {
    await this.read(scriptId);
    const [likeCount, viewCount] = await Promise.all([
      this.prisma.scriptLike.count({ where: { scriptId } }),
      this.prisma.scriptView.count({ where: { scriptId } }),
    ]);
    return { likeCount, viewCount };
  }

  async hasLike(scriptId, userId) {
    const row = await this.prisma.scriptLike.findUnique({
      where: { scriptId_userId: { scriptId, userId } },
    });
    return Boolean(row);
  }

  async toggleLike(scriptId, userId) {
    await this.read(scriptId);
    const existing = await this.prisma.scriptLike.findUnique({
      where: { scriptId_userId: { scriptId, userId } },
    });
    if (existing) {
      await this.prisma.scriptLike.delete({ where: { scriptId_userId: { scriptId, userId } } });
    } else {
      await this.prisma.scriptLike.create({ data: { scriptId, userId } });
    }
    const likeCount = await this.prisma.scriptLike.count({ where: { scriptId } });
    return { liked: !existing, likeCount };
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
