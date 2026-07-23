const { AppError } = require('../errors');
const { cleanText } = require('../shared/text');

function publicSummary(script) {
  return {
    id: script.id,
    title: script.title,
    slug: script.slug,
    author: script.author,
    publishedAt: script.publishedAt,
    likeCount: Number(script.likeCount || 0),
  };
}

function ownerView(script) {
  return {
    ...script,
    likeCount: Number(script.likeCount || 0),
    sharePath: `/scripts/${script.slug}`,
  };
}

function createScriptsService({ store }) {
  function resolveAuthor(author) {
    return cleanText(author || 'Anonymous', 200) || 'Anonymous';
  }

  async function create(input, { tenantId, userId }) {
    const author = resolveAuthor(input.author);
    return ownerView(await store.create({ ...input, author }, { tenantId, createdByUserId: userId }));
  }

  async function list({ tenantId }) {
    return (await store.list({ tenantId })).map(ownerView);
  }

  async function get(id, { tenantId }) {
    return ownerView(await store.read(id, { tenantId }));
  }

  async function update(id, patch, { tenantId }) {
    return ownerView(await store.update(id, patch, { tenantId }));
  }

  async function setVisibility(id, visibility, { tenantId }) {
    if (visibility !== 'public' && visibility !== 'private') {
      throw new AppError('INVALID_VISIBILITY', 'Visibility must be public or private', { status: 400 });
    }
    return ownerView(await store.update(id, { visibility }, { tenantId }));
  }

  async function listPublic(options) {
    return (await store.listPublic(options)).map(publicSummary);
  }

  async function getPublicBySlug(slug, { userId } = {}) {
    const script = await store.findBySlug(slug);
    if (!script || script.visibility !== 'public') {
      throw new AppError('SCRIPT_NOT_FOUND', 'Script not found', { status: 404 });
    }
    const moreByAuthor = await store.listPublic({
      createdByUserId: script.createdByUserId,
      excludeId: script.id,
      limit: 6,
    });
    return {
      ...publicSummary(script),
      scriptText: script.scriptText,
      createdByUserId: script.createdByUserId,
      likedByMe: userId ? await store.hasLike(script.id, userId) : false,
      moreByAuthor: moreByAuthor.map(publicSummary),
    };
  }

  async function toggleLike(scriptId, { userId }) {
    const script = await store.read(scriptId);
    if (script.visibility !== 'public') {
      throw new AppError('SCRIPT_NOT_FOUND', 'Script not found', { status: 404 });
    }
    return store.toggleLike(scriptId, userId);
  }

  async function ensureForProject(project, { tenantId, userId, author, projectStore } = {}) {
    const scope = { tenantId: tenantId || project.tenantId };
    if (project.scriptId) {
      const synced = await store.update(project.scriptId, {
        title: project.title,
        scriptText: project.scriptText || '',
      }, scope);
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
    return ownerView(await store.update(project.scriptId, {
      title: project.title,
      scriptText: project.scriptText || '',
    }, { tenantId: tenantId || project.tenantId }));
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

  return {
    create, list, get, update, setVisibility, listPublic, getPublicBySlug, toggleLike,
    ensureForProject, syncFromProject, listProjects, publicSummary, ownerView,
  };
}

module.exports = { createScriptsService, publicSummary, ownerView };
