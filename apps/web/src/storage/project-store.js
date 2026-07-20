const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AppError } = require('../errors');
const { attachLegacyImageProjection, hasLegacySceneImageState, imageShot, migrateSceneImageToImplicitShot } = require('../shared/scene-shots');
const { normalizeReferenceImages, normalizeReferenceRole } = require('../shared/reference-roles');

const SCENE_ASSET_FIELDS = Object.freeze({
  image: { list: 'versions', activeIndex: 'activeVersionIndex', visualType: 'image', owner: 'shot' },
  audio: { list: 'audioVersions', activeIndex: 'activeAudioVersionIndex', visualType: null },
  video: { list: 'videoVersions', activeIndex: 'activeVideoVersionIndex', visualType: 'video', owner: 'shot' },
  subtitle: { list: 'subtitleVersions', activeIndex: 'activeSubtitleVersionIndex', visualType: null },
});

class ProjectStore {
  constructor(root, options = {}) {
    this.root = path.resolve(root);
    this.tombstoneRoot = path.join(this.root, '.tombstones');
    this.maxFiles = Number(options.maxFiles || process.env.PROJECT_MAX_FILES || 500);
    this.maxBytes = Number(options.maxBytes || process.env.PROJECT_MAX_BYTES || 2 * 1024 * 1024 * 1024);
    fs.mkdirSync(this.tombstoneRoot, { recursive: true });
    this.recoverCleanups();
  }

  assertId(id) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(String(id || ''))) throw new AppError('INVALID_PROJECT_ID', 'Invalid project id', { status: 400 });
    return String(id);
  }

  projectDir(id) { return path.join(this.root, this.assertId(id)); }
  documentPath(id) { return path.join(this.projectDir(id), 'project.json'); }
  referencePath(id) { return path.join(this.projectDir(id), 'asset-references.json'); }
  tombstonePath(id) { return path.join(this.tombstoneRoot, `${this.assertId(id)}.json`); }
  isTombstoned(id) { return fs.existsSync(this.tombstonePath(id)); }

  assetDir(id, type, { create = true } = {}) {
    if (!['images', 'audio', 'videos', 'subtitles', 'exports', 'ai-references', 'scene-images'].includes(type)) throw new AppError('INVALID_ASSET_TYPE', 'Invalid asset type', { status: 400 });
    const dir = path.join(this.projectDir(id), 'assets', type);
    if (create) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  atomicJson(file, value) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const temp = path.join(dir, `.${path.basename(file)}-${crypto.randomUUID()}.tmp`);
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    const dirFd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  }

  assertOwner(document, ownerId) {
    if (ownerId && (document.tenantId || document.ownerId) !== ownerId) throw new AppError('PROJECT_NOT_FOUND', 'Project not found', { status: 404 });
  }

  create(input = {}, { ownerId, tenantId, createdByUserId } = {}) {
    const id = this.assertId(input.id || crypto.randomUUID());
    if (this.isTombstoned(id)) throw new AppError('PROJECT_DELETED', 'Project id has been permanently deleted', { status: 410 });
    if (fs.existsSync(this.documentPath(id))) throw new AppError('PROJECT_EXISTS', 'Project already exists', { status: 409 });
    const now = new Date().toISOString();
    const scopeId = tenantId || ownerId || input.tenantId || input.ownerId || 'local-user';
    const document = this.normalize({ ...(input.project || {}), id, tenantId: scopeId, createdByUserId: createdByUserId || input.createdByUserId || scopeId, title: input.title || input.project?.title || 'Untitled', revision: 1, incarnationId: crypto.randomUUID(), createdAt: now, updatedAt: now });
    this.atomicJson(this.documentPath(id), document);
    this.atomicJson(this.referencePath(id), {});
    return document;
  }

  read(id, { ownerId } = {}) {
    if (this.isTombstoned(id)) {
      try { const tombstone = JSON.parse(fs.readFileSync(this.tombstonePath(id), 'utf8')); if (ownerId && (tombstone.tenantId || tombstone.ownerId) !== ownerId) throw new AppError('PROJECT_NOT_FOUND', 'Project not found', { status: 404 }); } catch (error) { if (error instanceof AppError) throw error; }
      throw new AppError('PROJECT_DELETED', 'Project has been deleted', { status: 410 });
    }
    const file = this.documentPath(id);
    if (!fs.existsSync(file)) throw new AppError('PROJECT_NOT_FOUND', 'Project not found', { status: 404 });
    try {
      let document = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Number.isInteger(document.revision) || !document.tenantId || !document.incarnationId || this.hasLegacyContinuity(document) || this.hasLegacyAssets(document) || this.hasLegacyImageShots(document) || this.hasLegacyReferenceRoles(document)) {
        const revision = Number.isInteger(document.revision) ? document.revision + 1 : 1;
        document = this.normalize({ ...document, id, revision, tenantId: document.tenantId || document.ownerId || 'local-user', createdByUserId: document.createdByUserId || document.ownerId || 'local-user', incarnationId: document.incarnationId || crypto.randomUUID() });
        this.atomicJson(file, document);
        this.syncReferences(id, document.assetReferences || []);
      }
      if (!fs.existsSync(this.referencePath(id))) this.syncReferences(id, document.assetReferences || []);
      this.assertOwner(document, ownerId);
      document.scenes = (document.scenes || []).map((scene) => attachLegacyImageProjection(scene));
      return document;
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError('PROJECT_CORRUPT', 'Project data is unreadable', { status: 500, cause });
    }
  }

  write(id, document, { expectedRevision, ownerId } = {}) {
    const existing = this.read(id, { ownerId });
    if (expectedRevision !== undefined && Number(expectedRevision) !== existing.revision) {
      throw new AppError('REVISION_CONFLICT', `Expected revision ${expectedRevision}, current revision is ${existing.revision}`, { status: 409, details: { expectedRevision: Number(expectedRevision), currentRevision: existing.revision } });
    }
    const next = this.normalize({ ...document, id, tenantId: existing.tenantId || existing.ownerId, createdByUserId: existing.createdByUserId || existing.ownerId, incarnationId: existing.incarnationId, revision: existing.revision + 1, createdAt: existing.createdAt, updatedAt: new Date().toISOString() });
    this.atomicJson(this.documentPath(id), next);
    this.syncReferences(id, next.assetReferences || []);
    return next;
  }

  normalize(document) {
    const copy = structuredClone(document);
    copy.tenantId = copy.tenantId || copy.ownerId || 'local-user';
    copy.createdByUserId = copy.createdByUserId || copy.ownerId || copy.tenantId;
    delete copy.ownerId;
    delete copy.storyBible;
    delete copy.schemaVersion;
    copy.scenes = Array.isArray(copy.scenes) ? copy.scenes.map((scene) => {
      const next = { ...scene };
      delete next.entityRefs;
      delete next.continuity;
      // One-time migration shim, not ongoing parsing: only ever runs for a scene that still has the
      // old {speaker,text} lines shape and no narrationText yet. Keeps speaker meaning instead of
      // flattening it away, but the "Name said." phrasing is a fallback for old data only — never
      // reuse this pattern in live generation, which produces narrationText directly.
      if (typeof next.narrationText !== 'string' && Array.isArray(next.lines)) {
        next.narrationText = next.lines
          .map((line) => (line?.speaker && line.speaker !== 'Narrator' ? `"${line.text}" ${line.speaker} said.` : line?.text))
          .filter(Boolean)
          .join('\n\n');
      }
      delete next.lines;
      if (Array.isArray(next.referenceImages)) next.referenceImages = normalizeReferenceImages(next.referenceImages);
      return migrateSceneImageToImplicitShot(next);
    }) : [];
    this.migrateLegacyAssets(copy);
    copy.scenes = copy.scenes.map((scene) => attachLegacyImageProjection(scene));
    delete copy.assetReferences;
    copy.assetReferences = this.collectReferences(copy, copy.id);
    return copy;
  }

  hasLegacyContinuity(document) {
    return Boolean(document.storyBible || document.schemaVersion === 4 || document.scenes?.some((scene) => scene.entityRefs || scene.continuity || Array.isArray(scene.lines)));
  }

  hasLegacyImageShots(document) {
    return Boolean(document.scenes?.some((scene) => hasLegacySceneImageState(scene)));
  }

  hasLegacyReferenceRoles(document) {
    return Boolean(document.scenes?.some((scene) => {
      const references = Array.isArray(scene.shots?.[0]?.referenceBindings) ? scene.shots[0].referenceBindings : scene.referenceImages;
      return references?.some((reference) => reference?.role !== normalizeReferenceRole(reference?.role));
    }));
  }

  hasLegacyAssets(document) {
    return Boolean(document.scenes?.some((scene) => [
      ...(imageShot(scene).versions || []),
      ...(scene.audioVersions || []),
      ...(imageShot(scene).videoVersions || []),
    ].some((version) => /^\/(generated|audio|videos)\//.test(version?.path || ''))));
  }

  migrateLegacyAssets(document) {
    const mappings = [
      { field: 'versions', legacy: 'generated', type: 'images' },
      { field: 'audioVersions', legacy: 'audio', type: 'audio' },
      { field: 'videoVersions', legacy: 'videos', type: 'videos' },
    ];
    for (const scene of document.scenes || []) {
      for (const mapping of mappings) {
        const owner = mapping.field === 'versions' || mapping.field === 'videoVersions' ? imageShot(scene) : scene;
        owner[mapping.field] = (owner[mapping.field] || []).map((version) => {
          const match = String(version?.path || '').match(new RegExp(`^/${mapping.legacy}/([^/]+)$`));
          if (!match) return version;
          let fileName;
          try { fileName = decodeURIComponent(match[1]); } catch (_) { return version; }
          if (!fileName || path.basename(fileName) !== fileName || fileName.includes('\\')) return version;
          const source = path.join(path.dirname(this.root), mapping.legacy, fileName);
          if (!fs.existsSync(source)) return version;
          const destination = path.join(this.assetDir(document.id, mapping.type), fileName);
          if (!fs.existsSync(destination)) {
            const temp = `${destination}.${crypto.randomUUID()}.tmp`;
            try {
              fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL);
              const fd = fs.openSync(temp, 'r');
              try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
              fs.renameSync(temp, destination);
            } finally { fs.rmSync(temp, { force: true }); }
          }
          return { ...version, path: `/projects/${encodeURIComponent(document.id)}/assets/${mapping.type}/${encodeURIComponent(fileName)}` };
        });
      }
    }
    return document;
  }

  collectReferences(value, projectId, found = new Set()) {
    if (typeof value === 'string') {
      const prefix = `/projects/${encodeURIComponent(projectId)}/assets/`;
      if (value.startsWith(prefix)) found.add(value);
    } else if (Array.isArray(value)) value.forEach((item) => this.collectReferences(item, projectId, found));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => { if (key !== 'assetReferences') this.collectReferences(item, projectId, found); });
    return [...found].sort();
  }

  references(id) { try { return JSON.parse(fs.readFileSync(this.referencePath(id), 'utf8')); } catch (_) { return {}; } }
  syncReferences(id, paths) {
    const refs = Object.fromEntries(paths.map((assetPath) => [assetPath, ['project']]));
    this.atomicJson(this.referencePath(id), refs);
  }
  addReference(id, assetPath, reference) {
    const refs = this.references(id);
    refs[assetPath] = [...new Set([...(refs[assetPath] || []), reference])];
    this.atomicJson(this.referencePath(id), refs);
  }

  acquireLease(id, { ownerId } = {}) {
    const document = this.read(id, { ownerId });
    return Object.freeze({ projectId: id, incarnationId: document.incarnationId, ownerId: document.tenantId });
  }

  verifyLease(lease, signal) {
    if (signal?.aborted) throw signal.reason || new AppError('JOB_CANCELLED', 'Generation job cancelled', { status: 409 });
    const document = this.read(lease.projectId, { ownerId: lease.ownerId });
    if (document.incarnationId !== lease.incarnationId) throw new AppError('PROJECT_LEASE_EXPIRED', 'Project generation lease is no longer valid', { status: 409 });
    return document;
  }

  usage(id) {
    const root = path.join(this.projectDir(id), 'assets');
    let files = 0; let bytes = 0;
    if (!fs.existsSync(root)) return { files, bytes, maxFiles: this.maxFiles, maxBytes: this.maxBytes };
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!entry.name.endsWith('.tmp')) { files += 1; bytes += fs.statSync(full).size; }
    });
    walk(root);
    return { files, bytes, maxFiles: this.maxFiles, maxBytes: this.maxBytes };
  }

  commitAsset(lease, type, sourcePath, { fileName = path.basename(sourcePath), signal } = {}) {
    this.verifyLease(lease, signal);
    const safeName = path.basename(fileName);
    if (!safeName || safeName !== fileName || safeName.includes('\\')) throw new AppError('INVALID_PATH', 'Invalid asset filename', { status: 400 });
    const size = fs.statSync(sourcePath).size;
    const usage = this.usage(lease.projectId);
    if (usage.files + 1 > this.maxFiles || usage.bytes + size > this.maxBytes) throw new AppError('PROJECT_QUOTA_EXCEEDED', 'Project storage quota exceeded', { status: 413, details: { ...usage, requestedBytes: size } });
    const dir = this.assetDir(lease.projectId, type);
    const destination = path.join(dir, safeName);
    const temp = path.join(dir, `.${safeName}-${crypto.randomUUID()}.tmp`);
    fs.copyFileSync(sourcePath, temp, fs.constants.COPYFILE_EXCL);
    const tempFd = fs.openSync(temp, 'r');
    try { fs.fsyncSync(tempFd); } finally { fs.closeSync(tempFd); }
    try {
      this.verifyLease(lease, signal);
      fs.renameSync(temp, destination);
      const dirFd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    }
    finally { fs.rmSync(temp, { force: true }); }
    const publicPath = `/projects/${encodeURIComponent(lease.projectId)}/assets/${type}/${encodeURIComponent(safeName)}`;
    try {
      this.verifyLease(lease, signal);
      this.addReference(lease.projectId, publicPath, `generation:${crypto.randomUUID()}`);
    } catch (error) {
      fs.rmSync(destination, { force: true });
      throw error;
    }
    return { fileName: safeName, sourcePath: destination, path: publicPath };
  }

  attachSceneVersion(lease, { sceneId, kind, version, jobId }) {
    const fields = SCENE_ASSET_FIELDS[kind];
    if (!fields) throw new AppError('INVALID_ASSET_TYPE', 'Invalid scene asset kind', { status: 400 });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const document = this.read(lease.projectId, { ownerId: lease.ownerId });
      if (document.incarnationId !== lease.incarnationId) throw new AppError('PROJECT_LEASE_EXPIRED', 'Project generation lease is no longer valid', { status: 409 });
      const scene = document.scenes?.find((item) => item.id === sceneId);
      if (!scene) throw new AppError('SCENE_NOT_FOUND', 'Scene not found', { status: 404 });
      const owner = fields.owner === 'shot' ? imageShot(scene) : scene;
      const list = Array.isArray(owner[fields.list]) ? owner[fields.list] : [];
      if (jobId && list.some((entry) => entry?.jobId === jobId)) return { project: document, scene };
      owner[fields.list] = [...list, { ...version, jobId }];
      owner[fields.activeIndex] = owner[fields.list].length - 1;
      if (fields.visualType) scene.activeVisualType = fields.visualType;
      try {
        const next = this.write(lease.projectId, document, { expectedRevision: document.revision, ownerId: lease.ownerId });
        return { project: next, scene: next.scenes.find((item) => item.id === sceneId) };
      } catch (error) {
        if (error.code !== 'REVISION_CONFLICT') throw error;
      }
    }
    throw new AppError('PROJECT_WRITE_CONFLICT', 'Could not persist scene asset after repeated conflicts', { status: 409 });
  }

  delete(id, { ownerId } = {}) {
    const document = this.read(id, { ownerId });
    this.atomicJson(this.tombstonePath(id), { id, tenantId: document.tenantId, incarnationId: document.incarnationId, deletedAt: new Date().toISOString() });
    fs.rmSync(this.projectDir(id), { recursive: true, force: true });
  }

  deleteAsset(id, type, fileName, { ownerId } = {}) {
    const document = this.read(id, { ownerId });
    const safeName = path.basename(String(fileName || ''));
    if (!safeName || safeName !== fileName || safeName.includes('\\')) throw new AppError('INVALID_PATH', 'Invalid asset path', { status: 400 });
    const publicPath = `/projects/${encodeURIComponent(id)}/assets/${type}/${encodeURIComponent(safeName)}`;
    const references = [...new Set([...(this.references(id)[publicPath] || []), ...(document.assetReferences?.includes(publicPath) ? ['project'] : [])])];
    if (references.length) throw new AppError('ASSET_IN_USE', 'Asset is referenced by the project and cannot be deleted', { status: 409, details: { path: publicPath, references } });
    const file = path.join(this.assetDir(id, type, { create: false }), safeName);
    if (!fs.existsSync(file)) throw new AppError('ASSET_NOT_FOUND', 'Asset not found', { status: 404 });
    fs.rmSync(file, { force: true });
  }

  cleanup(id, { ownerId } = {}) {
    const document = this.read(id, { ownerId });
    const referenced = new Set([...Object.keys(this.references(id)), ...(document.assetReferences || [])]);
    const trash = path.join(this.projectDir(id), `.cleanup-${crypto.randomUUID()}`);
    const moved = [];
    fs.mkdirSync(trash, { recursive: true });
    try {
      for (const type of ['images', 'audio', 'videos', 'subtitles', 'exports', 'ai-references', 'scene-images']) {
        const dir = this.assetDir(id, type);
        for (const fileName of fs.readdirSync(dir)) {
          const publicPath = `/projects/${encodeURIComponent(id)}/assets/${type}/${encodeURIComponent(fileName)}`;
          if (type !== 'exports' && referenced.has(publicPath)) continue;
          const targetDir = path.join(trash, type); fs.mkdirSync(targetDir, { recursive: true });
          fs.renameSync(path.join(dir, fileName), path.join(targetDir, fileName)); moved.push({ type, fileName });
        }
      }
      this.atomicJson(path.join(trash, 'COMMITTED.json'), { committedAt: new Date().toISOString() });
      try { fs.rmSync(trash, { recursive: true, force: true }); } catch (_) { /* committed trash is completed during startup recovery */ }
      return moved;
    } catch (error) {
      for (const item of moved.reverse()) {
        const from = path.join(trash, item.type, item.fileName);
        if (fs.existsSync(from)) fs.renameSync(from, path.join(this.assetDir(id, item.type), item.fileName));
      }
      fs.rmSync(trash, { recursive: true, force: true });
      throw error;
    }
  }

  recoverCleanups() {
    for (const project of fs.readdirSync(this.root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))) {
      const projectDir = path.join(this.root, project.name);
      for (const entry of fs.readdirSync(projectDir, { withFileTypes: true }).filter((item) => item.isDirectory() && item.name.startsWith('.cleanup-'))) {
        const trash = path.join(projectDir, entry.name);
        if (fs.existsSync(path.join(trash, 'COMMITTED.json'))) { fs.rmSync(trash, { recursive: true, force: true }); continue; }
        for (const type of fs.readdirSync(trash, { withFileTypes: true }).filter((item) => item.isDirectory())) {
          const destination = path.join(projectDir, 'assets', type.name); fs.mkdirSync(destination, { recursive: true });
          for (const fileName of fs.readdirSync(path.join(trash, type.name))) fs.renameSync(path.join(trash, type.name, fileName), path.join(destination, fileName));
        }
        fs.rmSync(trash, { recursive: true, force: true });
      }
    }
  }

  list({ ownerId } = {}) {
    return fs.readdirSync(this.root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).flatMap((entry) => {
      try { return [this.read(entry.name, { ownerId })]; } catch (_) { return []; }
    }).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async resolveAsset(projectId, publicPath, { ownerId } = {}) {
    await this.read(projectId, { ownerId });
    const match = String(publicPath || '').match(/^\/projects\/([^/]+)\/assets\/([^/]+)\/([^/]+)$/);
    if (!match) return null;
    const pathProjectId = decodeURIComponent(match[1]);
    if (pathProjectId !== projectId) return null;
    const type = match[2];
    const fileName = decodeURIComponent(match[3]);
    if (fileName !== path.basename(fileName)) return null;

    const sourcePath = path.join(this.assetDir(projectId, type, { create: false }), fileName);
    if (!fs.existsSync(sourcePath)) return null;

    return {
      projectId,
      type,
      fileName,
      sourcePath,
      path: publicPath
    };
  }
}

module.exports = { ProjectStore };
