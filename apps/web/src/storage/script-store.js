const crypto = require('node:crypto');
const { AppError } = require('../errors');
const { slugify, cleanText } = require('../shared/text');

const SEED_CATEGORIES = [
  { id: '11111111-1111-4111-8111-111111111101', slug: 'feature', name: 'Feature', sortOrder: 10 },
  { id: '11111111-1111-4111-8111-111111111102', slug: 'short', name: 'Short', sortOrder: 20 },
  { id: '11111111-1111-4111-8111-111111111103', slug: 'pilot', name: 'Pilot', sortOrder: 30 },
  { id: '11111111-1111-4111-8111-111111111104', slug: 'web-series', name: 'Web Series', sortOrder: 40 },
  { id: '11111111-1111-4111-8111-111111111105', slug: 'other', name: 'Other', sortOrder: 90 },
];

function nowIso() {
  return new Date().toISOString();
}

class ScriptStore {
  constructor() {
    this.scripts = new Map();
    this.likes = new Set();
    this.categories = new Map(SEED_CATEGORIES.map((c) => [c.id, { ...c }]));
    this.tags = new Map();
    this.scriptTags = new Set();
    this.views = [];
  }

  likeKey(scriptId, userId) {
    return `${scriptId}:${userId}`;
  }

  scriptTagKey(scriptId, tagId) {
    return `${scriptId}:${tagId}`;
  }

  mapCategory(categoryId) {
    const cat = categoryId ? this.categories.get(categoryId) : null;
    return cat ? { id: cat.id, slug: cat.slug, name: cat.name } : null;
  }

  mapTags(scriptId) {
    const out = [];
    for (const key of this.scriptTags) {
      if (!key.startsWith(`${scriptId}:`)) continue;
      const tag = this.tags.get(key.slice(scriptId.length + 1));
      if (tag) out.push({ id: tag.id, slug: tag.slug, name: tag.name });
    }
    return out.sort((a, b) => a.slug.localeCompare(b.slug));
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
      logline: row.logline || '',
      categoryId: row.categoryId || null,
      category: this.mapCategory(row.categoryId),
      tags: this.mapTags(row.id),
      scriptText: row.scriptText,
      publishedAt: row.publishedAt || null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      likeCount: row.likeCount ?? this.countLikes(row.id),
      viewCount: row.viewCount ?? this.countViews(row.id),
      writer: row.writer || null,
    };
  }

  async create(input = {}, { tenantId, createdByUserId } = {}) {
    const id = input.id || crypto.randomUUID();
    const slug = await this.allocateSlug(input.slug || input.title || 'untitled', { excludeId: id });
    const createdAt = nowIso();
    const categoryId = input.categoryId || null;
    if (categoryId && !this.categories.has(categoryId)) {
      throw new AppError('CATEGORY_NOT_FOUND', 'Category not found', { status: 404 });
    }
    const row = {
      id,
      tenantId,
      createdByUserId,
      title: cleanText(input.title || 'Untitled', 200) || 'Untitled',
      slug,
      visibility: input.visibility === 'public' ? 'public' : 'private',
      author: cleanText(input.author || 'Anonymous', 200) || 'Anonymous',
      logline: cleanText(input.logline || '', 280),
      categoryId,
      scriptText: String(input.scriptText || ''),
      publishedAt: input.visibility === 'public' ? (input.publishedAt || createdAt) : null,
      createdAt,
      updatedAt: createdAt,
    };
    if ([...this.scripts.values()].some((item) => item.slug === row.slug)) {
      throw new AppError('SCRIPT_SLUG_EXISTS', 'Script slug already exists', { status: 409 });
    }
    this.scripts.set(id, row);
    if (Array.isArray(input.tagSlugs)) {
      const tags = await this.ensureTags(input.tagSlugs);
      await this.setScriptTags(id, tags.map((t) => t.id));
    }
    return this.map(row);
  }

  async read(id, { tenantId } = {}) {
    const row = this.scripts.get(id);
    if (!row || (tenantId && row.tenantId !== tenantId)) {
      throw new AppError('SCRIPT_NOT_FOUND', 'Script not found', { status: 404 });
    }
    return this.map(row);
  }

  async update(id, patch = {}, { tenantId } = {}) {
    const existing = await this.read(id, { tenantId });
    const next = {
      ...this.scripts.get(id),
      updatedAt: nowIso(),
    };
    if (patch.title != null) next.title = cleanText(patch.title, 200) || 'Untitled';
    if (patch.author != null) next.author = cleanText(patch.author, 200) || 'Anonymous';
    if (patch.scriptText != null) next.scriptText = String(patch.scriptText);
    if (patch.logline != null) next.logline = cleanText(patch.logline, 280);
    if (patch.slug != null) next.slug = await this.allocateSlug(patch.slug, { excludeId: id });
    if (patch.categoryId !== undefined) {
      if (patch.categoryId && !this.categories.has(patch.categoryId)) {
        throw new AppError('CATEGORY_NOT_FOUND', 'Category not found', { status: 404 });
      }
      next.categoryId = patch.categoryId || null;
    }
    if (patch.visibility === 'public') {
      next.visibility = 'public';
      next.publishedAt = existing.publishedAt || nowIso();
    } else if (patch.visibility === 'private') {
      next.visibility = 'private';
      next.publishedAt = null;
    }
    this.scripts.set(id, next);
    if (Array.isArray(patch.tagSlugs)) {
      const tags = await this.ensureTags(patch.tagSlugs);
      await this.setScriptTags(id, tags.map((t) => t.id));
    }
    return this.map(next);
  }

  async list({ tenantId } = {}) {
    return [...this.scripts.values()]
      .filter((row) => !tenantId || row.tenantId === tenantId)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map((row) => this.map(row));
  }

  async listPublic({ limit = 50, offset = 0, createdByUserId, excludeId, categorySlug, tagSlug } = {}) {
    return [...this.scripts.values()]
      .filter((row) => {
        if (row.visibility !== 'public') return false;
        if (createdByUserId && row.createdByUserId !== createdByUserId) return false;
        if (excludeId && row.id === excludeId) return false;
        if (categorySlug) {
          const cat = this.mapCategory(row.categoryId);
          if (!cat || cat.slug !== categorySlug) return false;
        }
        if (tagSlug && !this.mapTags(row.id).some((t) => t.slug === tagSlug)) return false;
        return true;
      })
      .sort((a, b) => String(b.publishedAt || b.updatedAt).localeCompare(String(a.publishedAt || a.updatedAt)))
      .slice(offset, offset + limit)
      .map((row) => this.map(row));
  }

  async findBySlug(slug) {
    const row = [...this.scripts.values()].find((item) => item.slug === slug);
    return row ? this.map(row) : null;
  }

  async listCategories() {
    return [...this.categories.values()]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .map((c) => ({ id: c.id, slug: c.slug, name: c.name, sortOrder: c.sortOrder }));
  }

  async findCategoryBySlug(slug) {
    return [...this.categories.values()].find((c) => c.slug === slug) || null;
  }

  async ensureTags(slugs = []) {
    const out = [];
    for (const raw of slugs) {
      const slug = slugify(String(raw || '')).slice(0, 40);
      if (!slug) continue;
      let tag = [...this.tags.values()].find((t) => t.slug === slug);
      if (!tag) {
        tag = { id: crypto.randomUUID(), slug, name: cleanText(String(raw), 40) || slug };
        this.tags.set(tag.id, tag);
      }
      out.push(tag);
    }
    return out;
  }

  async setScriptTags(scriptId, tagIds = []) {
    for (const key of [...this.scriptTags]) {
      if (key.startsWith(`${scriptId}:`)) this.scriptTags.delete(key);
    }
    for (const tagId of tagIds) this.scriptTags.add(this.scriptTagKey(scriptId, tagId));
  }

  countLikes(scriptId) {
    let count = 0;
    for (const key of this.likes) {
      if (key.startsWith(`${scriptId}:`)) count += 1;
    }
    return count;
  }

  countViews(scriptId) {
    return this.views.filter((v) => v.scriptId === scriptId).length;
  }

  async recordView(scriptId, viewerUserId = null) {
    await this.read(scriptId);
    this.views.push({ id: crypto.randomUUID(), scriptId, viewerUserId, createdAt: nowIso() });
    return { viewCount: this.countViews(scriptId) };
  }

  async getStats(scriptId) {
    await this.read(scriptId);
    return { likeCount: this.countLikes(scriptId), viewCount: this.countViews(scriptId) };
  }

  async hasLike(scriptId, userId) {
    return this.likes.has(this.likeKey(scriptId, userId));
  }

  async toggleLike(scriptId, userId) {
    await this.read(scriptId);
    const key = this.likeKey(scriptId, userId);
    if (this.likes.has(key)) {
      this.likes.delete(key);
      return { liked: false, likeCount: this.countLikes(scriptId) };
    }
    this.likes.add(key);
    return { liked: true, likeCount: this.countLikes(scriptId) };
  }

  async allocateSlug(raw, { excludeId } = {}) {
    const base = slugify(raw).slice(0, 80) || 'untitled';
    let candidate = base;
    let attempt = 0;
    while (true) {
      const existing = [...this.scripts.values()].find((item) => item.slug === candidate && item.id !== excludeId);
      if (!existing) return candidate;
      attempt += 1;
      candidate = `${base.slice(0, 60)}-${attempt}`;
    }
  }

  async linkProject() {
    return null;
  }
}

module.exports = { ScriptStore, SEED_CATEGORIES };
