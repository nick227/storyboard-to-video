const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getAdditionalCommonPrompt, slugify } = require('../shared/text');
const { providerOutput } = require('../providers/result');
const { AppError } = require('../errors');
const { createGenerationManifest, hashCanonical } = require('../shared/generation-manifest');
const { normalizeReferenceRole } = require('../shared/reference-roles');
const { imageShot } = require('../shared/scene-shots');
const { resolveImageReferencePlan } = require('../shared/image-reference-plan');
const { mergeMediaIntent, resolveImageOutput } = require('../shared/media-output-policy');

function createImageGenerationService({ config, styles, provider, projectStore }) {
  async function sceneReferencePaths(projectId, scene) {
    const paths = [];
    for (const reference of imageShot(scene).referenceBindings || []) {
      const expectedPrefix = `/projects/${encodeURIComponent(projectId)}/assets/images/`;
      if (!String(reference?.path || '').startsWith(expectedPrefix)) continue;
      let fileName;
      try { fileName = decodeURIComponent(String(reference?.path || '').split('/').pop()); } catch (_) { fileName = ''; }
      if (!fileName || path.basename(fileName) !== fileName || fileName.includes('\\')) continue;
      try {
        const asset = projectStore.findAsset
          ? await projectStore.findAsset(projectId, 'images', fileName)
          : { sourcePath: path.join(projectStore.assetDir(projectId, 'images', { create: false }), fileName) };
        if (fs.existsSync(asset.sourcePath)) paths.push({ localPath: asset.sourcePath, path: reference.path, source: 'scene', role: normalizeReferenceRole(reference.role) });
      } catch (_) { /* stale scene references are ignored during generation */ }
    }
    return paths;
  }

  function publicReferencePlan(referencePlan) {
    return {
      provider: referencePlan.provider,
      transport: referencePlan.capabilities.transport,
      maxReferences: referencePlan.capabilities.maxReferences,
      roleAwarePrompting: referencePlan.capabilities.roleAwarePrompting,
      included: referencePlan.included.map((reference) => ({ path: reference.path, source: reference.source, role: reference.role, order: reference.order, providerSlot: reference.providerSlot })),
      excluded: referencePlan.excluded.map((reference) => ({ path: reference.path, source: reference.source, role: reference.role, order: reference.candidateOrder, reason: reference.reason })),
    };
  }

  async function resolveReferenceContext(input, { ownerId, userId, signal, lease } = {}) {
    const style = styles.find(input.styleId);
    if (!style) throw new AppError('UNKNOWN_STYLE', 'Unknown style', { status: 400 });
    const project = lease
      ? await projectStore.verifyLease(lease, signal)
      : await projectStore.read(input.projectId, { ownerId });
    const models = { stub: 'stub-image-v1', openai: config.env.OPENAI_IMAGE_MODEL || 'gpt-image-1', dezgo: config.env.DEZGO_MODEL || 'text2image', gemini: config.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image' };
    const output = resolveImageOutput({
      provider: input.provider,
      model: models[input.provider],
      intent: mergeMediaIntent({ modality: 'image', platform: config.mediaOutputDefaults, project: project.mediaSettings, override: input.outputIntent }),
    });
    const scene = project.scenes?.find((item) => item.id === input.sceneId);
    if (!scene) throw new AppError('SCENE_NOT_FOUND', 'Scene not found', { status: 404 });
    const disabledDefaults = new Set(imageShot(scene).disabledStyleReferencePaths || []);
    const styleSources = styles.referenceSources
      ? styles.referenceSources(style.id, userId)
      : (styles.referencePaths?.(style.id, userId) || []).map((referencePath) => ({ path: referencePath, url: null }));
    const defaultReferences = styleSources
      .filter((item) => !item.url || !disabledDefaults.has(item.url))
      .map((item) => ({
        localPath: item.path,
        path: item.url || `style://${style.id}/${item.type || 'reference'}/${path.basename(item.path)}`,
        source: 'style',
        role: item.type === 'characters' ? 'character' : item.type === 'world' ? 'location' : 'composition',
      }));
    const uploadedReferences = await sceneReferencePaths(input.projectId, scene);
    const referencePlan = resolveImageReferencePlan(input.provider, [...uploadedReferences, ...defaultReferences]);
    const visiblePlan = publicReferencePlan(referencePlan);
    const referencePlanHash = hashCanonical(visiblePlan);
    return {
      style,
      project,
      scene,
      referencePlan,
      visiblePlan,
      referencePlanHash,
      referenceCount: referencePlan.included.length,
      sceneReferenceCount: referencePlan.included.filter((item) => item.source === 'scene').length,
      defaultReferenceCount: referencePlan.included.filter((item) => item.source === 'style').length,
      requiresConfirmation: input.provider !== 'stub' && referencePlan.excluded.length > 0,
      output,
    };
  }

  return {
    async preflight(input, context = {}) {
      const resolved = await resolveReferenceContext(input, context);
      return {
        provider: input.provider,
        referenceCount: resolved.referenceCount,
        sceneReferenceCount: resolved.sceneReferenceCount,
        defaultReferenceCount: resolved.defaultReferenceCount,
        omittedReferenceCount: resolved.visiblePlan.excluded.length,
        requiresConfirmation: resolved.requiresConfirmation,
        referencePlanHash: resolved.referencePlanHash,
        referencePlan: resolved.visiblePlan,
        output: resolved.output,
      };
    },

    async generate(input, { ownerId, userId, signal, jobId } = {}) {
      const lease = await projectStore.acquireLease(input.projectId, { ownerId, userId });
      const resolved = await resolveReferenceContext(input, { ownerId, userId, signal, lease });
      if (resolved.requiresConfirmation && input.confirmedReferencePlanHash !== resolved.referencePlanHash) {
        throw new AppError('REFERENCE_OMISSIONS_CONFIRMATION_REQUIRED', 'Reference omissions changed or were not confirmed. Review the current preflight plan before generating.', {
          status: 409,
          details: { referencePlanHash: resolved.referencePlanHash, referencePlan: resolved.visiblePlan },
        });
      }
      const { style, referencePlan } = resolved;
      const common = getAdditionalCommonPrompt(style.promptText, input.commonPromptText);
      const prompt = [style.promptText, common, input.scenePrompt, input.extraPromptText].filter(Boolean).join('\n\n');
      const selectedReferences = referencePlan.included;
      const references = selectedReferences.map((item) => item.localPath);
      const { sceneReferenceCount, defaultReferenceCount } = resolved;
      const referenceBindings = selectedReferences.map((reference) => ({ path: reference.localPath, role: reference.role, source: reference.source }));
      const providerResponse = await provider.generate({ provider: input.provider, prompt, references, referenceBindings, referencePlan, title: input.sceneTitle, output: resolved.output });
      const result = providerOutput(providerResponse);
      const metadata = providerResponse && Object.hasOwn(providerResponse, 'output') ? providerResponse : {};
      fs.mkdirSync(config.paths.generated, { recursive: true });
      const file = `${String(input.sceneNumber).padStart(2, '0')}-${slugify(input.sceneTitle || 'scene')}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${result.extension}`;
      const staged = path.join(config.paths.generated, file);
      try {
        fs.writeFileSync(staged, result.buffer);
        const asset = await projectStore.commitAsset(lease, 'images', staged, { signal, mimeType: result.mimeType });
        // `scenePrompt` is the raw scene-level prompt (what staleness compares against); `prompt` is
        // the full composed prompt actually sent to the provider (style + common + scene + extra) —
        // the two are never equal, so staleness must compare against `scenePrompt`, not `prompt`.
        const createdAt = new Date().toISOString();
        const manifest = createGenerationManifest({
          modality: 'image',
          createdAt,
          inputs: {
            operation: 'image.generate',
            prompt: { composed: prompt, scene: input.scenePrompt, style: style.promptText, common, extra: input.extraPromptText || '' },
            style: { id: style.id },
            provider: { name: metadata.provider || input.provider, model: metadata.model || null },
            settings: { ...(metadata.settings || {}), output: resolved.output },
            references: selectedReferences.map((reference) => ({ path: reference.path, source: reference.source, role: reference.role, order: reference.order, providerSlot: reference.providerSlot, consumed: true })),
          },
          result: { providerRequestId: metadata.providerRequestId || null, measurementStatus: metadata.measurementStatus || 'unavailable', mimeType: result.mimeType },
          omissions: referencePlan.excluded.map((reference) => ({ path: reference.path, source: reference.source, role: reference.role, order: reference.candidateOrder, reason: reference.reason })),
        });
        const version = { path: asset.path, prompt, scenePrompt: input.scenePrompt, provider: input.provider, output: resolved.output, manifest, manifestHash: manifest.manifestHash, createdAt };
        let scene, project;
        try {
          ({ scene, project } = await projectStore.attachSceneVersion(lease, { sceneId: input.sceneId, kind: 'image', version, jobId }));
        } catch (error) {
          if (projectStore.rollbackAsset) await projectStore.rollbackAsset(asset); else fs.rmSync(asset.sourcePath, { force: true });
          throw error;
        }
        return {
          image: { fileName: file, path: asset.path, prompt, mimeType: result.mimeType },
          referenceCount: references.length,
          defaultReferenceCount,
          sceneReferenceCount,
          referencePlan: resolved.visiblePlan,
          output: resolved.output,
          scene,
          revision: project.revision,
        };
      } finally {
        fs.rmSync(staged, { force: true });
      }
    },
  };
}

module.exports = { createImageGenerationService };
