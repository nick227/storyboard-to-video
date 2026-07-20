const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AppError } = require('../errors');
const { cleanText, getAdditionalCommonPrompt, slugify } = require('../shared/text');
const { providerOutput } = require('../providers/result');
const { createGenerationManifest } = require('../shared/generation-manifest');
const { imageShot } = require('../shared/scene-shots');
const { videoProviderCapabilities } = require('../shared/video-provider-capabilities');
const { resolveVideoInputPlan } = require('../shared/video-input-plan');
const { mergeMediaIntent, resolveVideoOutput } = require('../shared/media-output-policy');

const DEFAULT_MOTION_PROMPT = [
  'Show clear continuous subject movement and follow-through; never a frozen hold.',
].join(' ');

const INTENSITY_MOTION_PROMPTS = Object.freeze({
  subtle: 'Small continuous movement and gentle follow-through.',
  medium: DEFAULT_MOTION_PROMPT,
  high: 'Strong continuous action and pronounced follow-through; never a frozen hold.',
});

const STYLE_MOTION_PROMPTS = Object.freeze({
  'basic-cartoon': 'Exaggerated snap, recoil, comic timing.',
  'cinematic-reality': 'Grounded weight, natural momentum, realistic follow-through.',
  'dark-gothic': 'Restrained movement, heavy drift, ominous atmosphere.',
  'indie-youtuber': 'Lively gestures, casual energy, clean motion.',
  'money-wolf': 'Pop Art modern graphical realism, popular references.', 
  'vox-style': 'Crisp cutout slides, simple layers, light parallax.',
});

const VIDEO_PROMPT_WORD_BUDGET = Object.freeze({
  action: 24,
  motion: 18,
  visual: 28,
  style: 16,
  additionalStyle: 5,
});

function clipWords(value, limit) {
  return cleanText(value, 20_000).split(/\s+/).filter(Boolean).slice(0, limit).join(' ');
}

function buildVideoPrompt(input, style, configuredMotionPrompt = '') {
  const common = getAdditionalCommonPrompt(style.promptText, input.commonPromptText);
  const intensityMotion = INTENSITY_MOTION_PROMPTS[input.motionIntensity] || INTENSITY_MOTION_PROMPTS.medium;
  const styleMotion = STYLE_MOTION_PROMPTS[style.id] || 'Clear readable motion.';
  const motion = cleanText(`${input.motionPrompt || configuredMotionPrompt || intensityMotion} ${styleMotion}`, 4_000);
  return [
    input.sceneBeat ? `Story action: ${clipWords(input.sceneBeat, VIDEO_PROMPT_WORD_BUDGET.action)}` : '',
    `Motion direction: ${clipWords(motion, VIDEO_PROMPT_WORD_BUDGET.motion)}`,
    input.scenePrompt ? `Scene visual prompt: ${clipWords(input.scenePrompt, VIDEO_PROMPT_WORD_BUDGET.visual)}` : '',
    `Style baseline: ${clipWords(style.promptText, VIDEO_PROMPT_WORD_BUDGET.style)}`,
    common ? `Additional style direction: ${clipWords(common, VIDEO_PROMPT_WORD_BUDGET.additionalStyle)}` : '',
  ].filter(Boolean).join('\n\n');
}

function createVideoGenerationService({ config, provider, providers, execution, projectStore, styles }) {
  async function resolve(publicPath, ownerId) {
    if (!publicPath) return null;
    const match = String(publicPath).match(/^\/projects\/([^/]+)\/assets\/[^/]+\/[^/]+$/);
    if (!match) return null;
    const projectId = decodeURIComponent(match[1]);
    const asset = await projectStore.resolveAsset(projectId, publicPath, { ownerId });
    return asset?.sourcePath || null;
  }

  function fileHash(sourcePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
  }

  async function finalizeRecoveredExecution(outcome) {
    const { attempt, result: providerResponse } = outcome;
    const snapshot = attempt.requestSnapshot;
    const context = snapshot.finalization;
    if (!context) throw new AppError('VIDEO_FINALIZATION_CONTEXT_MISSING', 'Recovered video attempt has no finalization context', { status: 500 });
    const outputPath = providerOutput(providerResponse)?.outputPath;
    if (!outputPath || !fs.existsSync(outputPath)) throw new AppError('VIDEO_OUTPUT_MISSING', 'Recovered video output is unavailable for commit', { status: 500, retryable: true });
    const lease = await projectStore.acquireLease(context.projectId, { ownerId: context.ownerId, userId: context.userId });
    const metadata = providerResponse && Object.hasOwn(providerResponse, 'output') ? providerResponse : {};
    let asset;
    try {
      asset = await projectStore.commitAsset(lease, 'videos', outputPath, { mimeType: 'video/mp4' });
      const createdAt = new Date().toISOString();
      const consumedRoles = new Set(snapshot.inputPlan.included.map((item) => item.role));
      const allInputs = [...snapshot.inputPlan.included, ...snapshot.inputPlan.excluded].sort((a, b) => a.candidateOrder - b.candidateOrder);
      const manifest = createGenerationManifest({
        modality: 'video', createdAt,
        inputs: {
          operation: 'video.generate', prompt: context.promptInputs, style: { id: context.styleId },
          provider: { name: metadata.provider || attempt.provider, model: metadata.model || attempt.model },
          settings: { ...(metadata.settings || {}), output: snapshot.outputSelection, motionIntensity: snapshot.motionIntensity || 'medium' },
          sourceAssets: allInputs.map((item) => ({ role: item.role, path: item.assetPath, sha256: item.sha256, consumed: consumedRoles.has(item.role) })),
          inputPlan: { mode: attempt.generationMode, included: snapshot.inputPlan.included, excluded: snapshot.inputPlan.excluded, output: snapshot.inputPlan.output },
        },
        result: { providerRequestId: metadata.providerRequestId || null, measurementStatus: metadata.measurementStatus || 'unavailable', mimeType: 'video/mp4' },
      });
      const version = { path: asset.path, prompt: snapshot.prompt, sourceImagePath: context.startFramePath, startFramePath: context.startFramePath, endFramePath: context.endFramePath, provider: metadata.provider || attempt.provider, output: snapshot.outputSelection, manifest, manifestHash: manifest.manifestHash, createdAt };
      const attached = await projectStore.attachSceneVersion(lease, { sceneId: context.sceneId, kind: 'video', version, jobId: attempt.generationJobId });
      await execution.markCommitted(attempt.id);
      return { video: { fileName: path.basename(outputPath), path: asset.path, sourceImagePath: context.startFramePath, startFramePath: context.startFramePath, endFramePath: context.endFramePath, prompt: snapshot.prompt, mimeType: 'video/mp4', provider: metadata.provider || attempt.provider, output: snapshot.outputSelection }, scene: attached.scene, revision: attached.project.revision };
    } catch (error) {
      if (asset) { if (projectStore.rollbackAsset) await projectStore.rollbackAsset(asset); else fs.rmSync(asset.sourcePath, { force: true }); }
      await execution.markCommitFailed(attempt.id, error);
      throw error;
    } finally {
      fs.rmSync(outputPath, { force: true });
    }
  }

  return {
    verify: async (input = {}) => {
      const providerName = input.provider || config.videoProvider || 'ltx';
      const mode = input.generationMode || 'image_to_video';
      if (providers) return providers.verify({ provider: providerName, model: input.model, mode });
      return { ...(await provider.verify()), capabilities: provider.getCapabilities ? provider.getCapabilities() : videoProviderCapabilities(providerName, input.model, mode) };
    },
    async generate(input, { ownerId, userId, signal, jobId } = {}) {
      const lease = await projectStore.acquireLease(input.projectId, { ownerId, userId });
      const project = await projectStore.verifyLease(lease, signal);
      const sceneBeforeGeneration = project.scenes?.find((scene) => scene.id === input.sceneId);
      if (!sceneBeforeGeneration) throw new AppError('SCENE_NOT_FOUND', 'Scene not found', { status: 404 });
      const shot = imageShot(sceneBeforeGeneration);
      const activeImage = shot.versions?.[shot.activeVersionIndex] || null;
      const startFramePath = shot.startFrame || activeImage?.path || input.imagePath || null;
      const endFramePath = shot.endFrame || null;
      const startSource = await resolve(startFramePath, ownerId);
      if (!startSource || !fs.existsSync(startSource)) {
        throw new AppError('INVALID_PATH', 'A valid generated reference image is required', { status: 400 });
      }
      const endSource = endFramePath ? await resolve(endFramePath, ownerId) : null;
      if (endFramePath && (!endSource || !fs.existsSync(endSource))) throw new AppError('INVALID_END_FRAME', 'The selected end frame is unavailable', { status: 400 });
      const projectVideoDefaults = project.mediaSettings?.video || {};
      const providerName = input.provider || projectVideoDefaults.provider || config.videoProvider || 'ltx';
      const model = input.model || (providerName === projectVideoDefaults.provider ? projectVideoDefaults.model : undefined);
      const generationMode = input.generationMode || 'image_to_video';
      const providerResolution = providers ? providers.resolve({ provider: providerName, model, mode: generationMode }) : null;
      const capabilities = providerResolution ? providerResolution.capabilities : provider.getCapabilities ? provider.getCapabilities() : videoProviderCapabilities(providerName, model, generationMode);
      const output = resolveVideoOutput({
        provider: providerName,
        model: providerResolution?.model || model || capabilities.model,
        mode: generationMode,
        intent: mergeMediaIntent({ modality: 'video', platform: config.mediaOutputDefaults, project: project.mediaSettings, override: input.outputIntent }),
      });
      const style = styles.find(input.styleId);
      if (!style) throw new AppError('STYLE_NOT_FOUND', 'Unknown style', { status: 400 });

      const prompt = buildVideoPrompt(input, style, config.env.VIDEO_MOTION_PROMPT);
      if (providers) await providers.verify({ provider: providerName, model, mode: generationMode }); else await provider.verify();
      fs.mkdirSync(config.paths.videos, { recursive: true });
      const file = `${String(input.sceneNumber).padStart(2, '0')}-${slugify(input.sceneTitle || 'scene')}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.mp4`;
      const staged = path.join(config.paths.videos, file);
      let preserveStaged = false;
      try {
        const inputPlan = resolveVideoInputPlan({
          provider: providerName, model: providerResolution?.model || model, mode: generationMode, capabilities,
          inputs: [
            { role: 'start_frame', assetPath: startFramePath, sourcePath: startSource, sha256: fileHash(startSource) },
            ...(endFramePath ? [{ role: 'end_frame', assetPath: endFramePath, sourcePath: endSource, sha256: fileHash(endSource) }] : []),
          ],
          output: { ...(input.outputIntent || {}), requestedOutput: output.requested, resolvedOutput: output.resolved, seed: input.outputIntent?.seed ?? input.seed, providerOptions: input.outputIntent?.providerOptions || input.providerOptions },
        });
        let providerResponse;
        let attemptId = null;
        if (execution) {
          const executed = await execution.create({
            provider: providerName, model: inputPlan.model, generationMode, prompt, motionIntensity: input.motionIntensity,
            inputPlan, outputSelection: output, outputPath: staged,
            finalization: {
              projectId: input.projectId, sceneId: input.sceneId, sceneNumber: input.sceneNumber, sceneTitle: input.sceneTitle,
              ownerId, userId, startFramePath, endFramePath, styleId: style.id,
              promptInputs: { composed: prompt, scene: input.scenePrompt || '', beat: input.sceneBeat || '', style: style.promptText, common: getAdditionalCommonPrompt(style.promptText, input.commonPromptText), motion: input.motionPrompt || '' },
            },
          }, { ownerId, tenantId: ownerId, userId, jobId, projectId: input.projectId, sceneId: input.sceneId, signal });
          attemptId = executed.attempt.id;
          if (executed.pending) {
            preserveStaged = true;
            return { pending: true, attemptId, providerTaskId: executed.attempt.providerTaskId, provider: providerName, model: inputPlan.model, generationMode, output };
          }
          providerResponse = executed.result;
        } else {
          providerResponse = await provider.generate({ startFramePath: startSource, ...(capabilities.supportsEndFrame && endSource ? { endFramePath: endSource } : {}), prompt, motionIntensity: input.motionIntensity, outputSelection: output, outputPath: staged });
        }
        providerOutput(providerResponse);
        const metadata = providerResponse && Object.hasOwn(providerResponse, 'output') ? providerResponse : {};
        const asset = await projectStore.commitAsset(lease, 'videos', staged, { signal, mimeType: 'video/mp4' });
        const createdAt = new Date().toISOString();
        const manifest = createGenerationManifest({
          modality: 'video',
          createdAt,
          inputs: {
            operation: 'video.generate',
            prompt: { composed: prompt, scene: input.scenePrompt || '', beat: input.sceneBeat || '', style: style.promptText, common: getAdditionalCommonPrompt(style.promptText, input.commonPromptText), motion: input.motionPrompt || '' },
            style: { id: style.id },
            provider: { name: metadata.provider || providerName, model: metadata.model || inputPlan.model || null },
            settings: { ...(metadata.settings || {}), output, motionIntensity: input.motionIntensity || 'medium' },
            sourceAssets: [
              { role: 'start_frame', path: startFramePath, sha256: fileHash(startSource), consumed: inputPlan.included.some((item) => item.role === 'start_frame') },
              ...(endFramePath ? [{ role: 'end_frame', path: endFramePath, sha256: fileHash(endSource), consumed: inputPlan.included.some((item) => item.role === 'end_frame') }] : []),
            ],
            inputPlan: { mode: generationMode, included: inputPlan.included.map(({ sourcePath, ...item }) => item), excluded: inputPlan.excluded.map(({ sourcePath, ...item }) => item), output: inputPlan.output },
          },
          result: { providerRequestId: metadata.providerRequestId || null, measurementStatus: metadata.measurementStatus || 'unavailable', mimeType: 'video/mp4' },
        });
        const version = { path: asset.path, prompt, sourceImagePath: startFramePath, startFramePath, endFramePath, provider: metadata.provider || providerName, output, manifest, manifestHash: manifest.manifestHash, createdAt };
        let scene, project;
        try {
          ({ scene, project } = await projectStore.attachSceneVersion(lease, { sceneId: input.sceneId, kind: 'video', version, jobId }));
        } catch (error) {
          if (projectStore.rollbackAsset) await projectStore.rollbackAsset(asset); else fs.rmSync(asset.sourcePath, { force: true });
          if (attemptId) await execution.markCommitFailed(attemptId, error);
          throw error;
        }
        if (attemptId) await execution.markCommitted(attemptId);
        return {
          video: {
            fileName: file,
            path: asset.path,
            sourceImagePath: startFramePath,
            startFramePath,
            endFramePath,
            prompt,
            mimeType: 'video/mp4',
            provider: metadata.provider || providerName,
            output,
          },
          scene,
          revision: project.revision,
        };
      } finally {
        if (!preserveStaged) fs.rmSync(staged, { force: true });
      }
    },
    cancelAttempt: (attemptId) => execution.cancel(attemptId),
    reconcileAttempts: () => execution.reconcile(finalizeRecoveredExecution),
  };
}

module.exports = { DEFAULT_MOTION_PROMPT, INTENSITY_MOTION_PROMPTS, STYLE_MOTION_PROMPTS, VIDEO_PROMPT_WORD_BUDGET, buildVideoPrompt, createVideoGenerationService };
