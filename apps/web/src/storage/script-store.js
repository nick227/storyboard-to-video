const crypto = require('node:crypto');
const { AppError } = require('../errors');
const { slugify, cleanText } = require('../shared/text');

function nowIso() {
  return new Date().toISOString();
}

class ScriptStore {
  constructor() {
    this.scripts = new Map();
    this.likes = new Set();
  }

  likeKey(scriptId, userId) {
    return `${scriptId}:${userId}`;
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
      publishedAt: row.publishedAt || null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      likeCount: row.likeCount || 0,
    };
  }

  async create(input = {}, { tenantId, createdByUserId } = {}) {
    const id = input.id || crypto.randomUUID();
    const slug = await this.allocateSlug(input.slug || input.title || 'untitled', { excludeId: id });
    const createdAt = nowIso();
    const row = {
      id,
      tenantId,
      createdByUserId,
      title: cleanText(input.title || 'Untitled', 200) || 'Untitled',
      slug,
      visibility: input.visibility === 'public' ? 'public' : 'private',
      author: cleanText(input.author || 'Anonymous', 200) || 'Anonymous',
      scriptText: String(input.scriptText || ''),
      publishedAt: input.visibility === 'public' ? (input.publishedAt || createdAt) : null,
      createdAt,
      updatedAt: createdAt,
    };
    if ([...this.scripts.values()].some((item) => item.slug === row.slug)) {
      throw new AppError('SCRIPT_SLUG_EXISTS', 'Script slug already exists', { status: 409 });
    }
    this.scripts.set(id, row);
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
      ...existing,
      ...patch,
      id: existing.id,
      tenantId: existing.tenantId,
      createdByUserId: existing.createdByUserId,
      createdAt: existing.createdAt,
      updatedAt: nowIso(),
    };
    if (patch.title != null) next.title = cleanText(patch.title, 200) || 'Untitled';
    if (patch.author != null) next.author = cleanText(patch.author, 200) || 'Anonymous';
    if (patch.scriptText != null) next.scriptText = String(patch.scriptText);
    if (patch.slug != null) next.slug = await this.allocateSlug(patch.slug, { excludeId: id });
    if (patch.visibility === 'public') {
      next.visibility = 'public';
      next.publishedAt = existing.publishedAt || nowIso();
    } else if (patch.visibility === 'private') {
      next.visibility = 'private';
      next.publishedAt = null;
    }
    this.scripts.set(id, next);
    return this.map(next);
  }

  async list({ tenantId } = {}) {
    return [...this.scripts.values()]
      .filter((row) => !tenantId || row.tenantId === tenantId)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map((row) => this.map(row));
  }

  async listPublic({ limit = 50, offset = 0, createdByUserId, excludeId } = {}) {
    return [...this.scripts.values()]
      .filter((row) => row.visibility === 'public'
        && (!createdByUserId || row.createdByUserId === createdByUserId)
        && (!excludeId || row.id !== excludeId))
      .sort((a, b) => String(b.publishedAt || b.updatedAt).localeCompare(String(a.publishedAt || a.updatedAt)))
      .slice(offset, offset + limit)
      .map((row) => this.map({ ...row, likeCount: this.countLikes(row.id) }));
  }

  async findBySlug(slug) {
    const row = [...this.scripts.values()].find((item) => item.slug === slug);
    if (!row) return null;
    return this.map({ ...row, likeCount: this.countLikes(row.id) });
  }

  countLikes(scriptId) {
    let count = 0;
    for (const key of this.likes) {
      if (key.startsWith(`${scriptId}:`)) count += 1;
    }
    return count;
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

module.exports = { ScriptStore };
