const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Prisma } = require('../../dist/generated/prisma/client.js');
const { ProjectStore } = require('./project-store');
const { AppError } = require('../errors');
const { imageShot } = require('../shared/scene-shots');

const SCENE_ASSET_FIELDS = Object.freeze({
  image: { list: 'versions', activeIndex: 'activeVersionIndex', visualType: 'image', owner: 'shot' },
  audio: { list: 'audioVersions', activeIndex: 'activeAudioVersionIndex', visualType: null },
  video: { list: 'videoVersions', activeIndex: 'activeVideoVersionIndex', visualType: 'video', owner: 'shot' },
  subtitle: { list: 'subtitleVersions', activeIndex: 'activeSubtitleVersionIndex', visualType: null },
});

function json(value) { return value == null ? null : JSON.parse(JSON.stringify(value)); }

class PrismaProjectRepository extends ProjectStore {
  constructor(root, prisma, options = {}) { super(root, options); this.prisma = prisma; }

  map(row) {
    if (!row) return null;
    return this.normalize({
      ...json(row.document), id: row.id, tenantId: row.tenantId, createdByUserId: row.createdByUserId,
      title: row.title, revision: row.revision, incarnationId: row.incarnationId,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    });
  }

  async create(input = {}, { ownerId, tenantId, createdByUserId } = {}) {
    const id = this.assertId(input.id || crypto.randomUUID());
    const tombstone = await this.prisma.projectTombstone.findUnique({ where: { projectId: id } });
    if (tombstone) throw new AppError('PROJECT_DELETED', 'Project id has been permanently deleted', { status: 410 });
    const now = new Date();
    const scopeId = tenantId || ownerId || input.tenantId;
    const document = this.normalize({ ...(input.project || {}), id, tenantId: scopeId, createdByUserId: createdByUserId || input.createdByUserId, title: input.title || input.project?.title || 'Untitled', revision: 1, incarnationId: crypto.randomUUID(), createdAt: now.toISOString(), updatedAt: now.toISOString() });
    try {
      const row = await this.prisma.project.create({ data: {
        id, tenantId: document.tenantId, createdByUserId: document.createdByUserId, title: document.title,
        revision: 1, incarnationId: document.incarnationId, document: json(document), createdAt: now, updatedAt: now,
      } });
      fs.mkdirSync(this.projectDir(id), { recursive: true });
      return this.map(row);
    } catch (cause) {
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2002') throw new AppError('PROJECT_EXISTS', 'Project already exists', { status: 409 });
      throw cause;
    }
  }

  async read(id, { ownerId } = {}) {
    this.assertId(id);
    const row = await this.prisma.project.findUnique({ where: { id } });
    if (row && (!ownerId || row.tenantId === ownerId)) return this.map(row);
    if (row) throw new AppError('PROJECT_NOT_FOUND', 'Project not found', { status: 404 });
    const tombstone = await this.prisma.projectTombstone.findUnique({ where: { projectId: id } });
    if (tombstone && (!ownerId || tombstone.tenantId === ownerId)) throw new AppError('PROJECT_DELETED', 'Project has been deleted', { status: 410 });
    throw new AppError('PROJECT_NOT_FOUND', 'Project not found', { status: 404 });
  }

  async write(id, document, { expectedRevision, ownerId } = {}) {
    const existing = await this.read(id, { ownerId });
    if (expectedRevision !== undefined && Number(expectedRevision) !== existing.revision) throw new AppError('REVISION_CONFLICT', `Expected revision ${expectedRevision}, current revision is ${existing.revision}`, { status: 409, details: { expectedRevision: Number(expectedRevision), currentRevision: existing.revision } });
    const next = this.normalize({ ...document, id, tenantId: existing.tenantId, createdByUserId: existing.createdByUserId, incarnationId: existing.incarnationId, revision: existing.revision + 1, createdAt: existing.createdAt, updatedAt: new Date().toISOString() });
    const result = await this.prisma.project.updateMany({
      where: { id, tenantId: existing.tenantId, revision: existing.revision },
      data: { title: next.title, revision: next.revision, document: json(next), updatedAt: new Date(next.updatedAt) },
    });
    if (!result.count) {
      const current = await this.read(id, { ownerId });
      throw new AppError('REVISION_CONFLICT', `Expected revision ${existing.revision}, current revision is ${current.revision}`, { status: 409, details: { expectedRevision: existing.revision, currentRevision: current.revision } });
    }
    return next;
  }

  async list({ ownerId } = {}) {
    const rows = await this.prisma.project.findMany({ where: ownerId ? { tenantId: ownerId } : {}, orderBy: { updatedAt: 'desc' } });
    return rows.map((row) => this.map(row));
  }

  async acquireLease(id, { ownerId, userId } = {}) {
    const document = await this.read(id, { ownerId });
    return Object.freeze({ projectId: id, incarnationId: document.incarnationId, ownerId: document.tenantId, userId: userId || null });
  }

  async verifyLease(lease, signal) {
    if (signal?.aborted) throw signal.reason || new AppError('JOB_CANCELLED', 'Generation job cancelled', { status: 409 });
    const document = await this.read(lease.projectId, { ownerId: lease.ownerId });
    if (document.incarnationId !== lease.incarnationId) throw new AppError('PROJECT_LEASE_EXPIRED', 'Project generation lease is no longer valid', { status: 409 });
    return document;
  }

  async usage(id) {
    const aggregate = await this.prisma.asset.aggregate({ where: { projectId: id, status: 'committed' }, _count: true, _sum: { byteSize: true } });
    return { files: aggregate._count, bytes: Number(aggregate._sum.byteSize || 0n), maxFiles: this.maxFiles, maxBytes: this.maxBytes };
  }

  async commitAsset(lease, type, sourcePath, { fileName = path.basename(sourcePath), signal, mimeType } = {}) {
    await this.verifyLease(lease, signal);
    const safeName = path.basename(fileName);
    if (!safeName || safeName !== fileName || safeName.includes('\\')) throw new AppError('INVALID_PATH', 'Invalid asset filename', { status: 400 });
    const size = fs.statSync(sourcePath).size;
    const usage = await this.usage(lease.projectId);
    if (usage.files + 1 > this.maxFiles || usage.bytes + size > this.maxBytes) throw new AppError('PROJECT_QUOTA_EXCEEDED', 'Project storage quota exceeded', { status: 413, details: { ...usage, requestedBytes: size } });
    const dir = this.assetDir(lease.projectId, type);
    const destination = path.join(dir, safeName);
    if (fs.existsSync(destination)) throw new AppError('ASSET_EXISTS', 'An asset with that filename already exists', { status: 409 });
    const temp = path.join(dir, `.${safeName}-${crypto.randomUUID()}.tmp`);
    fs.copyFileSync(sourcePath, temp, fs.constants.COPYFILE_EXCL);
    try {
      await this.verifyLease(lease, signal);
      fs.renameSync(temp, destination);
      const publicPath = `/projects/${encodeURIComponent(lease.projectId)}/assets/${type}/${encodeURIComponent(safeName)}`;
      const storageKey = `projects/${lease.projectId}/assets/${type}/${safeName}`;
      const record = await this.prisma.asset.create({ data: {
        id: crypto.randomUUID(), tenantId: lease.ownerId, userId: lease.userId, projectId: lease.projectId, type, fileName: safeName,
        storageKey, publicPath, mimeType: mimeType || null, byteSize: BigInt(size), status: 'committed',
      } });
      return { id: record.id, fileName: safeName, sourcePath: destination, path: publicPath };
    } catch (error) {
      fs.rmSync(destination, { force: true });
      throw error;
    } finally { fs.rmSync(temp, { force: true }); }
  }

  async rollbackAsset(asset) {
    if (asset?.id) await this.prisma.asset.deleteMany({ where: { id: asset.id } });
    if (asset?.sourcePath) fs.rmSync(asset.sourcePath, { force: true });
  }

  async findAsset(id, type, fileName, { ownerId } = {}) {
    await this.read(id, { ownerId });
    const safeName = path.basename(String(fileName || ''));
    if (!safeName || safeName !== fileName || safeName.includes('\\')) throw new AppError('INVALID_PATH', 'Invalid asset path', { status: 400 });
    const record = await this.prisma.asset.findUnique({ where: { projectId_type_fileName: { projectId: id, type, fileName: safeName } } });
    if (!record || record.status !== 'committed') throw new AppError('ASSET_NOT_FOUND', 'Asset not found', { status: 404 });
    const sourcePath = path.join(this.assetDir(id, type, { create: false }), safeName);
    if (!fs.existsSync(sourcePath)) throw new AppError('ASSET_NOT_FOUND', 'Asset bytes are unavailable', { status: 404 });
    return { ...record, byteSize: Number(record.byteSize), sourcePath, path: record.publicPath };
  }

  async attachSceneVersion(lease, { sceneId, kind, version, jobId }) {
    const fields = SCENE_ASSET_FIELDS[kind];
    if (!fields) throw new AppError('INVALID_ASSET_TYPE', 'Invalid scene asset kind', { status: 400 });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const document = await this.verifyLease(lease);
      const scene = document.scenes?.find((item) => item.id === sceneId);
      if (!scene) throw new AppError('SCENE_NOT_FOUND', 'Scene not found', { status: 404 });
      const owner = fields.owner === 'shot' ? imageShot(scene) : scene;
      const list = Array.isArray(owner[fields.list]) ? owner[fields.list] : [];
      if (jobId && list.some((entry) => entry?.jobId === jobId)) return { project: document, scene };
      owner[fields.list] = [...list, { ...version, jobId }];
      owner[fields.activeIndex] = owner[fields.list].length - 1;
      if (fields.visualType) scene.activeVisualType = fields.visualType;
      try {
        const project = await this.write(lease.projectId, document, { expectedRevision: document.revision, ownerId: lease.ownerId });
        return { project, scene: project.scenes.find((item) => item.id === sceneId) };
      } catch (error) { if (error.code !== 'REVISION_CONFLICT') throw error; }
    }
    throw new AppError('PROJECT_WRITE_CONFLICT', 'Could not persist scene asset after repeated conflicts', { status: 409 });
  }

  async deleteAsset(id, type, fileName, { ownerId } = {}) {
    const document = await this.read(id, { ownerId });
    const asset = await this.findAsset(id, type, fileName, { ownerId });
    if (document.assetReferences?.includes(asset.publicPath)) throw new AppError('ASSET_IN_USE', 'Asset is referenced by the project and cannot be deleted', { status: 409, details: { path: asset.publicPath, references: ['project'] } });
    await this.rollbackAsset(asset);
  }

  async cleanup(id, { ownerId } = {}) {
    const document = await this.read(id, { ownerId });
    const referenced = new Set(document.assetReferences || []);
    const assets = await this.prisma.asset.findMany({ where: { projectId: id, status: 'committed' } });
    const removed = [];
    for (const asset of assets) {
      if (asset.type !== 'exports' && referenced.has(asset.publicPath)) continue;
      await this.rollbackAsset({ id: asset.id, sourcePath: path.join(this.assetDir(id, asset.type, { create: false }), asset.fileName) });
      removed.push({ type: asset.type, fileName: asset.fileName });
    }
    return removed;
  }

  async delete(id, { ownerId } = {}) {
    const document = await this.read(id, { ownerId });
    const projectDir = this.projectDir(id);
    const trash = `${projectDir}.deleted-${crypto.randomUUID()}`;
    if (fs.existsSync(projectDir)) fs.renameSync(projectDir, trash);
    try {
      await this.prisma.$transaction([
        this.prisma.projectTombstone.create({ data: { projectId: id, tenantId: document.tenantId, incarnationId: document.incarnationId } }),
        this.prisma.project.delete({ where: { id } }),
      ]);
      fs.rmSync(trash, { recursive: true, force: true });
    } catch (error) {
      if (fs.existsSync(trash)) fs.renameSync(trash, projectDir);
      throw error;
    }
  }

  async resolveAsset(id, publicPath, { ownerId } = {}) {
    await this.read(id, { ownerId });
    const match = String(publicPath || '').match(/^\/projects\/([^/]+)\/assets\/([^/]+)\/([^/]+)$/);
    if (!match) return null;
    const pathProjectId = decodeURIComponent(match[1]);
    if (pathProjectId !== id) return null;
    const type = match[2];
    const fileName = decodeURIComponent(match[3]);
    if (fileName !== path.basename(fileName)) return null;

    const record = await this.prisma.asset.findUnique({ where: { projectId_type_fileName: { projectId: id, type, fileName } } });
    if (!record || record.status !== 'committed') return null;

    const sourcePath = path.join(this.assetDir(id, type, { create: false }), fileName);
    if (!fs.existsSync(sourcePath)) return null;

    return {
      projectId: id,
      type,
      fileName,
      sourcePath,
      path: publicPath,
      mimeType: record.mimeType,
      byteSize: Number(record.byteSize)
    };
  }
}

module.exports = { PrismaProjectRepository };
