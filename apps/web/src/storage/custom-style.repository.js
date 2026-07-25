const crypto = require('node:crypto');
const { AppError } = require('../errors');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (value) => typeof value === 'string' && UUID_PATTERN.test(value);

function publicStyle(style) {
  if (!style) return null;
  return {
    id: style.id,
    userId: style.userId,
    title: style.title,
    promptText: style.promptText || '',
    writingGuidance: style.writingGuidance || '',
    status: style.status || 'active',
    createdAt: style.createdAt,
    updatedAt: style.updatedAt,
  };
}

function publicReference(reference) {
  if (!reference) return null;
  return {
    id: reference.id,
    styleId: reference.styleId,
    category: reference.category,
    fileName: reference.fileName,
    storageKey: reference.storageKey,
    mimeType: reference.mimeType,
    byteSize: Number(reference.byteSize),
    sortOrder: reference.sortOrder,
    status: reference.status || 'active',
    idempotencyKey: reference.idempotencyKey || null,
    source: reference.source || 'user_upload',
    promptSnapshot: reference.promptSnapshot || null,
    provider: reference.provider || null,
    model: reference.model || null,
    aspectRatio: reference.aspectRatio || null,
    generationRequestId: reference.generationRequestId || null,
    createdAt: reference.createdAt,
  };
}

class MemoryCustomStyleRepository {
  constructor() {
    this.styles = new Map();
    this.references = new Map();
  }

  async list(userId, { includeArchived = false } = {}) {
    return [...this.styles.values()]
      .filter((style) => style.userId === userId && (includeArchived || style.status === 'active'))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map(publicStyle);
  }

  async findOwned(id, userId, { includeArchived = true } = {}) {
    const style = this.styles.get(id);
    return style?.userId === userId && (includeArchived || style.status === 'active') ? publicStyle(style) : null;
  }

  async create(userId, input) {
    const now = new Date().toISOString();
    const style = {
      id: crypto.randomUUID(),
      userId,
      title: input.title,
      promptText: input.promptText || '',
      writingGuidance: input.writingGuidance || '',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.styles.set(style.id, style);
    return publicStyle(style);
  }

  async update(id, userId, patch) {
    const style = this.styles.get(id);
    if (!style || style.userId !== userId) throw new AppError('STYLE_NOT_FOUND', 'Custom style not found', { status: 404 });
    Object.assign(style, patch, { updatedAt: new Date().toISOString() });
    return publicStyle(style);
  }

  async archive(id, userId) {
    return this.update(id, userId, { status: 'archived' });
  }

  async listReferences(styleId, userId) {
    if (!await this.findOwned(styleId, userId)) throw new AppError('STYLE_NOT_FOUND', 'Custom style not found', { status: 404 });
    await this.cleanStalePendingReferences(styleId);
    return [...this.references.values()]
      .filter((reference) => reference.styleId === styleId && reference.status !== 'failed')
      .sort((a, b) => a.category.localeCompare(b.category) || a.sortOrder - b.sortOrder)
      .map(publicReference);
  }

  async addReference(styleId, userId, input) {
    if (!await this.findOwned(styleId, userId, { includeArchived: false })) throw new AppError('STYLE_NOT_FOUND', 'Custom style not found', { status: 404 });
    
    const duplicateSlot = [...this.references.values()].find((r) => r.styleId === styleId && r.category === input.category && r.sortOrder === input.sortOrder && r.status !== 'failed');
    if (duplicateSlot) {
      const error = new Error('Unique constraint failed on custom style reference slot');
      error.code = 'P2002';
      throw new AppError('REFERENCE_LIMIT', 'A concurrency conflict occurred or the reference limit was reached', { status: 400, cause: error });
    }

    const reference = { id: input.id || crypto.randomUUID(), styleId, ...input, createdAt: new Date().toISOString() };
    this.references.set(reference.id, reference);
    return publicReference(reference);
  }

  async cleanStalePendingReferences(styleId, maxAgeMs = 5 * 60 * 1000) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    for (const [id, ref] of this.references.entries()) {
      if (ref.styleId === styleId && ref.status === 'pending' && ref.createdAt < cutoff) {
        this.references.delete(id);
      }
    }
  }

  async findReferenceOwned(referenceId, styleId, userId) {
    const reference = this.references.get(referenceId);
    if (!reference || reference.styleId !== styleId || !await this.findOwned(styleId, userId)) return null;
    return publicReference(reference);
  }

  async findReferenceByIdempotencyKey(styleId, category, idempotencyKey) {
    if (!idempotencyKey) return null;
    const match = [...this.references.values()]
      .find((ref) => ref.styleId === styleId && ref.category === category && ref.idempotencyKey === idempotencyKey);
    return publicReference(match);
  }

  async updateReference(referenceId, styleId, userId, patch) {
    const reference = this.references.get(referenceId);
    if (!reference || reference.styleId !== styleId || !await this.findOwned(styleId, userId)) {
      throw new AppError('REFERENCE_NOT_FOUND', 'Style reference not found', { status: 404 });
    }
    Object.assign(reference, patch);
    return publicReference(reference);
  }

  async removeReference(referenceId, styleId, userId) {
    const reference = await this.findReferenceOwned(referenceId, styleId, userId);
    if (!reference) throw new AppError('REFERENCE_NOT_FOUND', 'Style reference not found', { status: 404 });
    this.references.delete(referenceId);
    return reference;
  }

  async reorderReferences(styleId, userId, category, ids) {
    const references = await this.listReferences(styleId, userId);
    const categoryReferences = references.filter((item) => item.category === category);
    if (ids.length !== categoryReferences.length || ids.some((id) => !categoryReferences.some((item) => item.id === id))) {
      throw new AppError('INVALID_REFERENCE_ORDER', 'Reference order must include every reference in this category', { status: 400 });
    }
    ids.forEach((id, sortOrder) => Object.assign(this.references.get(id), { sortOrder }));
    return this.listReferences(styleId, userId);
  }
}

class PrismaCustomStyleRepository {
  constructor(prisma) {
    this.prisma = prisma;
  }

  async list(userId, { includeArchived = false } = {}) {
    const rows = await this.prisma.customStyle.findMany({
      where: { userId, ...(includeArchived ? {} : { status: 'active' }) },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map(publicStyle);
  }

  async findOwned(id, userId, { includeArchived = true } = {}) {
    if (!isUuid(id) || !isUuid(userId)) return null;
    const row = await this.prisma.customStyle.findFirst({ where: { id, userId, ...(includeArchived ? {} : { status: 'active' }) } });
    return publicStyle(row);
  }

  async create(userId, input) {
    return publicStyle(await this.prisma.customStyle.create({
      data: {
        id: crypto.randomUUID(),
        userId,
        title: input.title,
        promptText: input.promptText || '',
        writingGuidance: input.writingGuidance || '',
      },
    }));
  }

  async update(id, userId, patch) {
    const style = await this.findOwned(id, userId);
    if (!style) throw new AppError('STYLE_NOT_FOUND', 'Custom style not found', { status: 404 });
    return publicStyle(await this.prisma.customStyle.update({ where: { id }, data: patch }));
  }

  async archive(id, userId) {
    return this.update(id, userId, { status: 'archived' });
  }

  async listReferences(styleId, userId) {
    if (!await this.findOwned(styleId, userId)) throw new AppError('STYLE_NOT_FOUND', 'Custom style not found', { status: 404 });
    await this.cleanStalePendingReferences(styleId);
    const rows = await this.prisma.customStyleReference.findMany({
      where: { styleId, status: { not: 'failed' } },
      orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }]
    });
    return rows.map(publicReference);
  }

  async addReference(styleId, userId, input) {
    if (!await this.findOwned(styleId, userId, { includeArchived: false })) throw new AppError('STYLE_NOT_FOUND', 'Custom style not found', { status: 404 });
    try {
      return publicReference(await this.prisma.customStyleReference.create({ data: { ...input, styleId, byteSize: BigInt(input.byteSize) } }));
    } catch (error) {
      const isUniqueConstraint = error.code === 'P2002' || (error.message && error.message.includes('Unique constraint'));
      if (isUniqueConstraint) {
        throw new AppError('REFERENCE_LIMIT', 'A concurrency conflict occurred or the reference limit was reached', { status: 400, cause: error });
      }
      throw error;
    }
  }

  async cleanStalePendingReferences(styleId, maxAgeMs = 5 * 60 * 1000) {
    const cutoff = new Date(Date.now() - maxAgeMs);
    await this.prisma.customStyleReference.deleteMany({
      where: {
        styleId,
        status: 'pending',
        createdAt: { lt: cutoff }
      }
    });
  }

  async findReferenceOwned(referenceId, styleId, userId) {
    if (!isUuid(referenceId) || !isUuid(styleId) || !isUuid(userId)) return null;
    const row = await this.prisma.customStyleReference.findFirst({ where: { id: referenceId, styleId, style: { userId } } });
    return publicReference(row);
  }

  async findReferenceByIdempotencyKey(styleId, category, idempotencyKey) {
    if (!isUuid(styleId) || !idempotencyKey) return null;
    const row = await this.prisma.customStyleReference.findFirst({
      where: { styleId, category, idempotencyKey }
    });
    return publicReference(row);
  }

  async updateReference(referenceId, styleId, userId, patch) {
    const reference = await this.findReferenceOwned(referenceId, styleId, userId);
    if (!reference) throw new AppError('REFERENCE_NOT_FOUND', 'Style reference not found', { status: 404 });
    const data = { ...patch };
    if (patch.byteSize !== undefined) data.byteSize = BigInt(patch.byteSize);
    return publicReference(await this.prisma.customStyleReference.update({ where: { id: referenceId }, data }));
  }

  async removeReference(referenceId, styleId, userId) {
    const reference = await this.findReferenceOwned(referenceId, styleId, userId);
    if (!reference) throw new AppError('REFERENCE_NOT_FOUND', 'Style reference not found', { status: 404 });
    await this.prisma.customStyleReference.delete({ where: { id: referenceId } });
    return reference;
  }

  async reorderReferences(styleId, userId, category, ids) {
    const references = await this.listReferences(styleId, userId);
    const categoryReferences = references.filter((item) => item.category === category);
    if (ids.length !== categoryReferences.length || ids.some((id) => !categoryReferences.some((item) => item.id === id))) {
      throw new AppError('INVALID_REFERENCE_ORDER', 'Reference order must include every reference in this category', { status: 400 });
    }
    // Use a two-pass transaction to avoid intermediate unique constraint conflicts on sortOrder
    await this.prisma.$transaction([
      ...ids.map((id, index) => this.prisma.customStyleReference.update({ where: { id }, data: { sortOrder: index + 100 } })),
      ...ids.map((id, sortOrder) => this.prisma.customStyleReference.update({ where: { id }, data: { sortOrder } }))
    ]);
    return this.listReferences(styleId, userId);
  }
}

module.exports = { MemoryCustomStyleRepository, PrismaCustomStyleRepository, publicStyle, publicReference };
