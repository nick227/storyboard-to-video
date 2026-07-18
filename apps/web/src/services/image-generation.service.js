const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getAdditionalCommonPrompt, slugify } = require('../shared/text');
const { providerOutput } = require('../providers/result');
const { AppError } = require('../errors');

function createImageGenerationService({ config, styles, provider, projectStore }) {
  async function sceneReferencePaths(projectId, scene) {
    const paths = [];
    for (const reference of scene?.referenceImages || []) {
      const expectedPrefix = `/projects/${encodeURIComponent(projectId)}/assets/images/`;
      if (!String(reference?.path || '').startsWith(expectedPrefix)) continue;
      let fileName;
      try { fileName = decodeURIComponent(String(reference?.path || '').split('/').pop()); } catch (_) { fileName = ''; }
      if (!fileName || path.basename(fileName) !== fileName || fileName.includes('\\')) continue;
      try {
        const asset = projectStore.findAsset
          ? await projectStore.findAsset(projectId, 'images', fileName)
          : { sourcePath: path.join(projectStore.assetDir(projectId, 'images', { create: false }), fileName) };
        if (fs.existsSync(asset.sourcePath)) paths.push(asset.sourcePath);
      } catch (_) { /* stale scene references are ignored during generation */ }
    }
    return paths;
  }

  return {
    async generate(input, { ownerId, userId, signal, jobId } = {}) {
      const style = styles.find(input.styleId);
      if (!style) {
        const error = new Error('Unknown style');
        error.statusCode = 400;
        throw error;
      }
      const common = getAdditionalCommonPrompt(style.promptText, input.commonPromptText);
      const prompt = [style.promptText, common, input.scenePrompt, input.extraPromptText].filter(Boolean).join('\n\n');
      const lease = await projectStore.acquireLease(input.projectId, { ownerId, userId });
      const projectBeforeGeneration = await projectStore.verifyLease(lease, signal);
      const sceneBeforeGeneration = projectBeforeGeneration.scenes?.find((item) => item.id === input.sceneId);
      if (!sceneBeforeGeneration) throw new AppError('SCENE_NOT_FOUND', 'Scene not found', { status: 404 });
      const disabledDefaults = new Set(sceneBeforeGeneration.disabledProjectReferenceImages || []);
      const styleSources = styles.referenceSources
        ? styles.referenceSources(style.id, userId)
        : (styles.referencePaths?.(style.id, userId) || []).map((referencePath) => ({ path: referencePath, url: null }));
      const defaultReferences = styleSources
        .filter((item) => !item.url || !disabledDefaults.has(item.url))
        .map((item) => item.path);
      const uploadedReferences = await sceneReferencePaths(input.projectId, sceneBeforeGeneration);
      const referenceLimit = input.provider === 'dezgo' ? 1 : input.provider === 'openai' ? 8 : 14;
      const references = [...uploadedReferences, ...defaultReferences].slice(0, referenceLimit);
      const sceneReferenceCount = Math.min(uploadedReferences.length, references.length);
      const defaultReferenceCount = references.length - sceneReferenceCount;
      const result = providerOutput(await provider.generate({ provider: input.provider, prompt, references, title: input.sceneTitle }));
      fs.mkdirSync(config.paths.generated, { recursive: true });
      const file = `${String(input.sceneNumber).padStart(2, '0')}-${slugify(input.sceneTitle || 'scene')}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${result.extension}`;
      const staged = path.join(config.paths.generated, file);
      try {
        fs.writeFileSync(staged, result.buffer);
        const asset = await projectStore.commitAsset(lease, 'images', staged, { signal, mimeType: result.mimeType });
        // `scenePrompt` is the raw scene-level prompt (what staleness compares against); `prompt` is
        // the full composed prompt actually sent to the provider (style + common + scene + extra) —
        // the two are never equal, so staleness must compare against `scenePrompt`, not `prompt`.
        const version = { path: asset.path, prompt, scenePrompt: input.scenePrompt, createdAt: new Date().toISOString() };
        let scene, project;
        try {
          ({ scene, project } = await projectStore.attachSceneVersion(lease, { sceneId: input.sceneId, kind: 'image', version, jobId }));
        } catch (error) {
          if (projectStore.rollbackAsset) await projectStore.rollbackAsset(asset); else fs.rmSync(asset.sourcePath, { force: true });
          throw error;
        }
        return { image: { fileName: file, path: asset.path, prompt, mimeType: result.mimeType }, referenceCount: references.length, defaultReferenceCount, sceneReferenceCount, scene, revision: project.revision };
      } finally {
        fs.rmSync(staged, { force: true });
      }
    },
  };
}

module.exports = { createImageGenerationService };
