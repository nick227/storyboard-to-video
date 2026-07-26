const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { AppError } = require('../errors');
const { cleanText } = require('../shared/text');
const { sharePathFor } = require('../shared/app-paths');
const { isArtifact, isArtifactPublic, hasAnyPublicArtifact, artifactState, artifactsFromRow, ARTIFACT_FIELDS, ARTIFACTS } = require('../shared/script-artifacts');
const { publicProjectView } = require('../shared/public-artifact-view');
const { detectImageExtension } = require('../media/image-format');
const { buildScriptCoverStorageKey } = require('../storage/blob-store');

function ownerCoverUrl(script) {
  if (!script?.coverStorageKey) return null;
  const bust = path.basename(script.coverStorageKey);
  return `/api/scripts/${encodeURIComponent(script.id)}/cover?v=${encodeURIComponent(bust)}`;
}

function publicCoverUrl(script) {
  if (!script?.coverStorageKey || !script?.slug) return null;
  const bust = path.basename(script.coverStorageKey);
  return `/api/public/scripts/${encodeURIComponent(script.slug)}/cover?v=${encodeURIComponent(bust)}`;
}

function publicSummary(script, { artifact = 'screenplay' } = {}) {
  const key = isArtifact(artifact) ? artifact : 'screenplay';
  const state = artifactState(script, key);
  const summary = {
    id: script.id,
    title: script.title,
    slug: script.slug,
    author: script.author,
    logline: script.logline || '',
    coverUrl: publicCoverUrl(script),
    category: script.category || null,
    tags: script.tags || [],
    artifact: key,
    visibility: state.visibility,
    publishedAt: state.publishedAt,
    artifacts: script.artifacts || artifactsFromRow(script),
    likeCount: Number(script.likeCount || 0),
    viewCount: Number(script.viewCount || 0),
    sharePath: sharePathFor(script, key),
  };
  if (script.writer) {
    summary.writer = {
      id: script.writer.id,
      profileSlug: script.writer.profileSlug,
      displayName: script.writer.displayName,
    };
  }
  return summary;
}

function ownerView(script) {
  const { coverStorageKey, ...rest } = script;
  return {
    ...rest,
    coverUrl: ownerCoverUrl(script),
    hasCover: Boolean(coverStorageKey),
    artifacts: script.artifacts || artifactsFromRow(script),
    likeCount: Number(script.likeCount || 0),
    viewCount: Number(script.viewCount || 0),
    sharePath: sharePathFor(script, 'screenplay'),
    sharePaths: {
      screenplay: sharePathFor(script, 'screenplay'),
      storyboard: sharePathFor(script, 'storyboard'),
      timeline: sharePathFor(script, 'timeline'),
    },
  };
}

function createScriptsService({ store, projectStore, blobStore } = {}) {
  function resolveAuthor(author) {
    return cleanText(author || 'Anonymous', 200) || 'Anonymous';
  }

  function taxonomyPatch(input = {}) {
    const patch = {};
    if (input.logline != null) patch.logline = input.logline;
    if (input.categoryId !== undefined) patch.categoryId = input.categoryId;
    if (input.tagSlugs != null) patch.tagSlugs = input.tagSlugs;
    return patch;
  }

  async function create(input, { tenantId, userId }) {
    const author = resolveAuthor(input.author);
    return ownerView(await store.create({
      ...input,
      author,
      ...taxonomyPatch(input),
    }, { tenantId, createdByUserId: userId }));
  }

  async function list({ tenantId }) {
    return (await store.list({ tenantId })).map(ownerView);
  }

  async function get(id, { tenantId }) {
    return ownerView(await store.read(id, { tenantId }));
  }

  async function update(id, patch, { tenantId }) {
    return ownerView(await store.update(id, { ...patch, ...taxonomyPatch(patch) }, { tenantId }));
  }

  async function setVisibility(id, visibility, { tenantId, artifact = 'screenplay' } = {}) {
    if (visibility !== 'public' && visibility !== 'private') {
      throw new AppError('INVALID_VISIBILITY', 'Visibility must be public or private', { status: 400 });
    }
    const key = isArtifact(artifact) ? artifact : 'screenplay';
    const field = ARTIFACT_FIELDS[key].visibility;
    return ownerView(await store.update(id, { [field]: visibility }, { tenantId }));
  }

  async function listPublic(options = {}) {
    const limit = Math.min(100, Math.max(1, Number(options.limit) || 50));
    const offset = Math.max(0, Number(options.offset) || 0);
    const categorySlug = options.categorySlug || options.category || undefined;
    const tagSlug = options.tagSlug || options.tag || undefined;
    const base = { ...options, categorySlug, tagSlug, limit, offset };

    if (options.artifact === 'all') {
      const perType = Math.min(100, offset + limit);
      const batches = await Promise.all(ARTIFACTS.map(async (artifact) => {
        const rows = await store.listPublic({ ...base, artifact, limit: perType, offset: 0 });
        return rows.map((script) => publicSummary(script, { artifact }));
      }));
      return batches
        .flat()
        .sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')))
        .slice(offset, offset + limit);
    }

    const artifact = isArtifact(options.artifact) ? options.artifact : 'screenplay';
    return (await store.listPublic({ ...base, artifact })).map((script) => publicSummary(script, { artifact }));
  }

  async function listPublicByCategory(slug, options = {}) {
    return listPublic({ ...options, categorySlug: slug });
  }

  async function listPublicByTag(slug, options = {}) {
    return listPublic({ ...options, tagSlug: slug });
  }

  async function listCategories({ onlyWithScripts = false } = {}) {
    return store.listCategories({ onlyWithScripts });
  }

  async function listTags() {
    return store.listTags ? store.listTags() : [];
  }

  async function getPublicBySlug(slug, { userId, artifact = 'screenplay' } = {}) {
    const key = isArtifact(artifact) ? artifact : 'screenplay';
    const script = await store.findBySlug(slug);
    if (!script || !isArtifactPublic(script, key)) {
      throw new AppError('SCRIPT_NOT_FOUND', 'Script not found', { status: 404 });
    }
    await store.recordView(script.id, userId || null);
    const refreshed = await store.findBySlug(slug);
    const moreByAuthor = await store.listPublic({
      createdByUserId: script.createdByUserId,
      excludeId: script.id,
      artifact: key,
      limit: 6,
    });
    const summary = publicSummary(refreshed || script, { artifact: key });
    const payload = {
      ...summary,
      scriptText: key === 'screenplay' ? script.scriptText : undefined,
      createdByUserId: script.createdByUserId,
      likedByMe: userId ? await store.hasLike(script.id, userId) : false,
      moreByAuthor: moreByAuthor.map((item) => publicSummary(item, { artifact: key })),
      breadcrumb: {
        category: summary.category,
        writer: summary.writer || null,
      },
    };
    if (key === 'storyboard' || key === 'timeline') {
      const project = projectStore?.findLatestByScriptId
        ? await projectStore.findLatestByScriptId(script.id)
        : null;
      payload.project = publicProjectView(project);
    }
    return payload;
  }

  async function canPublicReadProjectMedia(projectId) {
    if (!projectStore || !projectId) return false;
    let project;
    try {
      project = await projectStore.read(projectId);
    } catch (_) {
      return false;
    }
    if (!project?.scriptId) return false;
    let script;
    try {
      script = await store.read(project.scriptId);
    } catch (_) {
      return false;
    }
    return isArtifactPublic(script, 'storyboard') || isArtifactPublic(script, 'timeline');
  }

  async function toggleLike(scriptId, { userId }) {
    const script = await store.read(scriptId);
    if (!hasAnyPublicArtifact(script)) {
      throw new AppError('SCRIPT_NOT_FOUND', 'Script not found', { status: 404 });
    }
    return store.toggleLike(scriptId, userId);
  }

  async function getOwnerStats(scriptId, { tenantId }) {
    await store.read(scriptId, { tenantId });
    return store.getStats(scriptId);
  }

  function scriptSyncPatch(project) {
    const patch = { title: project.title };
    // Scene/media project PUTs often omit scriptText (JSON drops undefined). Never coerce that
    // to '' — it would wipe the canonical Script row and empty the editor on the next refresh.
    if (project.scriptText != null) patch.scriptText = project.scriptText;
    return patch;
  }

  async function ensureForProject(project, { tenantId, userId, author, projectStore } = {}) {
    const scope = { tenantId: tenantId || project.tenantId };
    if (project.scriptId) {
      const synced = await store.update(project.scriptId, scriptSyncPatch(project), scope);
      return ownerView(synced);
    }
    const script = await store.create({
      title: project.title || 'Untitled',
      scriptText: project.scriptText || '',
      author: resolveAuthor(author),
    }, { tenantId: scope.tenantId, createdByUserId: userId || project.createdByUserId });
    if (projectStore?.setScriptId) {
      await projectStore.setScriptId(project.id, script.id, { ownerId: scope.tenantId });
    } else if (store.linkProject) {
      await store.linkProject(project.id, script.id, scope);
    }
    project.scriptId = script.id;
    return ownerView(script);
  }

  async function syncFromProject(project, { tenantId } = {}) {
    if (!project.scriptId) return null;
    return ownerView(await store.update(project.scriptId, scriptSyncPatch(project), {
      tenantId: tenantId || project.tenantId,
    }));
  }

  async function listProjects(scriptId, { tenantId, projectStore }) {
    await store.read(scriptId, { tenantId });
    const projects = await projectStore.list({ ownerId: tenantId });
    return projects.filter((project) => project.scriptId === scriptId).map((project) => ({
      id: project.id,
      title: project.title,
      updatedAt: project.updatedAt,
      revision: project.revision,
    }));
  }

  async function resolveSharePath(slug, { artifact = 'screenplay' } = {}) {
    const key = isArtifact(artifact) ? artifact : 'screenplay';
    const script = await store.findBySlug(slug);
    if (!script || !isArtifactPublic(script, key)) {
      throw new AppError('SCRIPT_NOT_FOUND', 'Script not found', { status: 404 });
    }
    return sharePathFor(script, key);
  }

  async function uploadCover(scriptId, file, { tenantId }) {
    if (!blobStore) throw new AppError('STORAGE_UNAVAILABLE', 'Cover storage is unavailable', { status: 503 });
    if (!file?.buffer?.length) throw new AppError('VALIDATION_ERROR', 'Cover image is required', { status: 400 });
    const extension = detectImageExtension(file.buffer);
    if (!extension) {
      throw new AppError('INVALID_IMAGE', 'Only valid PNG, JPEG, WebP, and GIF images are accepted', { status: 400 });
    }
    const existing = await store.read(scriptId, { tenantId });
    const fileName = `${crypto.randomUUID()}.${extension}`;
    const storageKey = buildScriptCoverStorageKey(scriptId, fileName);
    const mimeType = file.mimetype || `image/${extension === 'jpg' ? 'jpeg' : extension}`;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'script-cover-'));
    const staged = path.join(tempDir, fileName);
    fs.writeFileSync(staged, file.buffer);
    try {
      await blobStore.put(storageKey, staged, { mimeType, byteSize: file.buffer.length });
      let updated;
      try {
        updated = await store.update(scriptId, {
          coverStorageKey: storageKey,
          coverMimeType: mimeType,
        }, { tenantId });
      } catch (error) {
        await blobStore.delete(storageKey).catch(() => {});
        throw error;
      }
      if (existing.coverStorageKey && existing.coverStorageKey !== storageKey) {
        await blobStore.delete(existing.coverStorageKey).catch(() => {});
      }
      return ownerView(updated);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async function removeCover(scriptId, { tenantId }) {
    if (!blobStore) throw new AppError('STORAGE_UNAVAILABLE', 'Cover storage is unavailable', { status: 503 });
    const existing = await store.read(scriptId, { tenantId });
    const updated = await store.update(scriptId, {
      coverStorageKey: null,
      coverMimeType: null,
    }, { tenantId });
    if (existing.coverStorageKey) {
      await blobStore.delete(existing.coverStorageKey).catch(() => {});
    }
    return ownerView(updated);
  }

  async function coverStream(scriptId, { tenantId } = {}) {
    if (!blobStore) throw new AppError('STORAGE_UNAVAILABLE', 'Cover storage is unavailable', { status: 503 });
    const script = await store.read(scriptId, tenantId ? { tenantId } : {});
    if (!script.coverStorageKey) throw new AppError('COVER_NOT_FOUND', 'Cover art not found', { status: 404 });
    return {
      mimeType: script.coverMimeType || 'application/octet-stream',
      stream: await blobStore.getStream(script.coverStorageKey),
    };
  }

  async function publicCoverStream(slug) {
    if (!blobStore) throw new AppError('STORAGE_UNAVAILABLE', 'Cover storage is unavailable', { status: 503 });
    const script = await store.findBySlug(slug);
    if (!script || !hasAnyPublicArtifact(script) || !script.coverStorageKey) {
      throw new AppError('COVER_NOT_FOUND', 'Cover art not found', { status: 404 });
    }
    return {
      mimeType: script.coverMimeType || 'application/octet-stream',
      stream: await blobStore.getStream(script.coverStorageKey),
    };
  }

  async function pipeCover(res, source) {
    res.type(source.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    try {
      await pipeline(source.stream, res);
    } catch (err) {
      if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw err;
    }
  }

  return {
    create, list, get, update, setVisibility, listPublic, listPublicByCategory, listPublicByTag,
    listCategories, listTags, getPublicBySlug, resolveSharePath, toggleLike, getOwnerStats, ensureForProject, syncFromProject,
    listProjects, canPublicReadProjectMedia, uploadCover, removeCover, coverStream, publicCoverStream, pipeCover,
    publicSummary, ownerView,
  };
}

module.exports = { createScriptsService, publicSummary, ownerView, ownerCoverUrl, publicCoverUrl };
