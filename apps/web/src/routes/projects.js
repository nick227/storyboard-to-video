const express = require('express');
const { createProject, projectDocument } = require('../schemas');
const { validate } = require('../middleware/validate');
const { AppError } = require('../errors');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { imageShot } = require('../shared/scene-shots');
const { mergeMediaIntent, resolveImageOutput } = require('../shared/media-output-policy');

function createProjectRouter({ store, queue, upload, shotReferences, styles, prompts, referenceGeneration, imageProvider, identityStore, prisma, config }) {
  const router = express.Router();
  const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

  router.get('/', asyncRoute(async (req, res) => res.json({ ok: true, projects: await store.list({ ownerId: req.auth.tenantId }) })));
  router.post('/', validate(createProject), asyncRoute(async (req, res) => {
    const mediaDefaults = identityStore?.getMediaDefaults ? await identityStore.getMediaDefaults(req.auth.userId) : null;
    const input = mediaDefaults ? { ...req.body, project: { ...(req.body.project || {}), mediaSettings: req.body.project?.mediaSettings || mediaDefaults } } : req.body;
    res.status(201).json({ ok: true, project: await store.create(input, { tenantId: req.auth.tenantId, createdByUserId: req.auth.userId }) });
  }));
  router.post('/:projectId/cleanup', asyncRoute(async (req, res) => res.json({ ok: true, removed: await store.cleanup(req.params.projectId, { ownerId: req.auth.tenantId }) })));
  router.post('/:projectId/scenes/:sceneId/references', upload.array('files', 8), asyncRoute(async (req, res) => {
    const result = await shotReferences.upload(req.params.projectId, req.params.sceneId, req.files, { ownerId: req.auth.tenantId, userId: req.auth.userId });
    res.json({ ok: true, scene: result.scene, revision: result.project.revision });
  }));
  router.delete('/:projectId/scenes/:sceneId/references', asyncRoute(async (req, res) => {
    const result = await shotReferences.remove(req.params.projectId, req.params.sceneId, req.body?.path, { ownerId: req.auth.tenantId, userId: req.auth.userId });
    res.json({ ok: true, scene: result.scene, revision: result.project.revision });
  }));
  router.patch('/:projectId/scenes/:sceneId/references/role', asyncRoute(async (req, res) => {
    const result = await shotReferences.setRole(req.params.projectId, req.params.sceneId, req.body?.path, req.body?.role, { ownerId: req.auth.tenantId, userId: req.auth.userId });
    res.json({ ok: true, scene: result.scene, revision: result.project.revision });
  }));
  router.delete('/:projectId/assets/:type/:fileName', asyncRoute(async (req, res) => {
    await store.deleteAsset(req.params.projectId, req.params.type, req.params.fileName, { ownerId: req.auth.tenantId });
    res.status(204).end();
  }));

  // GET /:projectId/assets/library
  router.get('/:projectId/assets/library', asyncRoute(async (req, res) => {
    const projectId = req.params.projectId;
    const styleId = req.query.styleId || '';
    
    let uploads = [];
    let generations = [];

    if (prisma) {
      const dbAssets = await prisma.asset.findMany({
        where: { projectId, status: 'committed' },
        orderBy: { createdAt: 'desc' }
      });
      for (const asset of dbAssets) {
        const isUpload = asset.fileName.startsWith('upload-') || asset.fileName.startsWith('scene-image-') || asset.fileName.startsWith('scene-reference-') || asset.fileName.startsWith('upload-ref-');
        const record = {
          fileName: asset.fileName,
          path: asset.publicPath,
          type: asset.type,
          createdAt: asset.createdAt.toISOString()
        };
        if (isUpload) uploads.push(record);
        else generations.push(record);
      }
    } else {
      const types = ['scene-images', 'ai-references', 'images'];
      for (const type of types) {
        const dir = store.assetDir(projectId, type, { create: false });
        if (fs.existsSync(dir)) {
          const files = fs.readdirSync(dir).filter(f => !f.startsWith('.'));
          for (const f of files) {
            const isUpload = f.startsWith('upload-') || f.startsWith('scene-image-') || f.startsWith('scene-reference-') || f.startsWith('upload-ref-');
            const record = {
              fileName: f,
              path: `/projects/${encodeURIComponent(projectId)}/assets/${type}/${encodeURIComponent(f)}`,
              type,
              createdAt: new Date().toISOString()
            };
            if (isUpload) uploads.push(record);
            else generations.push(record);
          }
        }
      }
    }

    if (styleId && styles) {
      const refs = styles.references(styleId, req.auth?.userId, { all: true });
      const allRefs = [...(refs.characters || []), ...(refs.world || [])];
      for (const ref of allRefs) {
        uploads.push({
          fileName: ref.fileName,
          path: ref.url,
          type: ref.type,
          createdAt: new Date().toISOString(),
          isSystemDefault: !ref.isUserUploaded
        });
      }
    }

    res.json({ ok: true, uploads, generations });
  }));

  // GET /:projectId/assets/past-storyboards
  router.get('/:projectId/assets/past-storyboards', asyncRoute(async (req, res) => {
    const projectId = req.params.projectId;
    const allProjects = await store.list({ ownerId: req.auth.tenantId });
    const pastStoryboards = [];

    for (const proj of allProjects) {
      if (proj.id === projectId) continue;
      try {
        const fullProj = await store.read(proj.id, { ownerId: req.auth.tenantId });
        const scenes = fullProj.scenes || [];
        for (const scene of scenes) {
          const versions = imageShot(scene).versions || [];
          for (const ver of versions) {
            if (ver.path) {
              pastStoryboards.push({
                projectId: proj.id,
                projectTitle: proj.title || 'Untitled',
                sceneId: scene.id,
                sceneTitle: scene.title || 'Scene',
                path: ver.path,
                createdAt: ver.createdAt || new Date().toISOString()
              });
            }
          }
        }
      } catch (_) {
        // ignore errors
      }
    }
    res.json({ ok: true, pastStoryboards });
  }));

  // POST /:projectId/images/generate-reference
  router.post('/:projectId/images/generate-reference', asyncRoute(async (req, res) => {
    const projectId = req.params.projectId;
    const { userPrompt, useStory, provider, styleId, mode } = req.body;
    if (!userPrompt && !useStory) {
      throw new AppError('VALIDATION_ERROR', 'Prompt or Use Story is required', { status: 400 });
    }

    const project = await store.read(projectId, { ownerId: req.auth.tenantId });
    let finalPrompt = userPrompt || '';
    if (useStory && prompts) {
      if (project.scriptText) {
        const storyPrompt = await referenceGeneration.generateVisualPromptFromScript({ scriptText: project.scriptText, provider, mode });
        if (storyPrompt) {
          finalPrompt = finalPrompt ? `${storyPrompt}\n\n${finalPrompt}` : storyPrompt;
        }
      }
    }

    const lease = await store.acquireLease(projectId, { ownerId: req.auth.tenantId, userId: req.auth.userId });
    const selectedStyle = styles.find(styleId || 'basic-cartoon');
    const stylePrompt = selectedStyle?.promptText || '';
    const fullPrompt = [stylePrompt, finalPrompt].filter(Boolean).join('\n\n');

    const providerName = provider || 'gemini';
    const imageModels = { stub: 'stub-image-v1', openai: config.env.OPENAI_IMAGE_MODEL || 'gpt-image-1', dezgo: config.env.DEZGO_MODEL || 'text2image', gemini: config.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image' };
    const output = resolveImageOutput({ provider: providerName, model: imageModels[providerName], intent: mergeMediaIntent({ modality: 'image', platform: config.mediaOutputDefaults, project: project.mediaSettings, override: req.body.outputIntent }) });
    const result = require('../providers/result').providerOutput(
      await imageProvider.generate({
        provider: providerName,
        prompt: fullPrompt,
        references: [],
        title: 'Reference',
        output,
      })
    );

    const fileName = `reference-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${result.extension}`;
    const staged = path.join(config.paths.generated, `.${fileName}.upload`);
    fs.mkdirSync(config.paths.generated, { recursive: true });
    fs.writeFileSync(staged, result.buffer);
    const asset = await store.commitAsset(lease, 'ai-references', staged, { fileName, mimeType: result.mimeType });
    fs.rmSync(staged, { force: true });

    res.json({ ok: true, path: asset.path, fileName: asset.fileName, prompt: fullPrompt });
  }));

  // POST /:projectId/images/upload-reference
  router.post('/:projectId/images/upload-reference', upload.array('files', 8), asyncRoute(async (req, res) => {
    const projectId = req.params.projectId;
    const files = req.files;
    if (!files?.length) throw new AppError('VALIDATION_ERROR', 'At least one file is required', { status: 400 });

    const { detectImageExtension } = require('../media/image-format');
    const prepared = files.map((file) => ({ file, extension: detectImageExtension(file.buffer) }));
    if (prepared.some((item) => !item.extension)) throw new AppError('INVALID_IMAGE', 'Only valid PNG, JPEG, WebP, and GIF images are accepted', { status: 400 });

    const lease = await store.acquireLease(projectId, { ownerId: req.auth.tenantId, userId: req.auth.userId });
    const committed = [];

    try {
      for (const [index, item] of prepared.entries()) {
        const fileName = `upload-ref-${Date.now()}-${index}-${crypto.randomBytes(3).toString('hex')}.${item.extension}`;
        const staged = path.join(config.paths.generated, `.${fileName}.upload`);
        fs.mkdirSync(config.paths.generated, { recursive: true });
        fs.writeFileSync(staged, item.file.buffer);
        const asset = await store.commitAsset(lease, 'ai-references', staged, { fileName, mimeType: item.file.mimetype });
        fs.rmSync(staged, { force: true });
        committed.push({ fileName: asset.fileName, path: asset.path });
      }
      res.json({ ok: true, files: committed });
    } catch (err) {
      for (const asset of committed) {
        let name = decodeURIComponent(asset.path.split('/').pop());
        await store.deleteAsset(projectId, 'ai-references', name, { ownerId: req.auth.tenantId });
      }
      throw err;
    }
  }));

  // POST /:projectId/scenes/:sceneId/images/upload
  router.post('/:projectId/scenes/:sceneId/images/upload', upload.single('file'), asyncRoute(async (req, res) => {
    const file = req.file;
    if (!file) throw new AppError('VALIDATION_ERROR', 'An image is required', { status: 400 });
    const result = await shotReferences.uploadShotImage(req.params.projectId, req.params.sceneId, file, { ownerId: req.auth.tenantId, userId: req.auth.userId });
    res.json({ ok: true, scene: result.scene, revision: result.project.revision });
  }));

  router.get('/:projectId', asyncRoute(async (req, res) => res.json({ ok: true, project: await store.read(req.params.projectId, { ownerId: req.auth.tenantId }) })));
  router.get('/:projectId/tokens', asyncRoute(async (req, res) => {
    const { projectId } = req.params;
    // Verify tenancy
    await store.read(projectId, { ownerId: req.auth.tenantId });
    
    if (!prisma) {
      return res.json({ ok: true, totalCostUSD: 0, totalTokens: 0, providers: {}, activePrices: [], estimatedPrices: [] });
    }

    const [events, activePrices] = await Promise.all([
      prisma.usageEvent.findMany({
        where: { projectId },
        include: { costSnapshot: true },
      }),
      prisma.providerPriceVersion.findMany({
        where: { active: true },
      }),
    ]);

    function estimateUsageCost(event) {
      const provider = event.provider || 'unknown';
      const modality = event.modality || 'unknown';
      const usage = event.usage || {};

      if (provider === 'stub') {
        return 0;
      }

      if (modality === 'text') {
        if (provider === 'openai') {
          const input = Number(usage.inputTokens || 0);
          const cached = Number(usage.cachedInputTokens || 0);
          const output = Number(usage.outputTokens || 0);
          const nonCached = Math.max(0, input - cached);
          return (nonCached * 400 + cached * 100 + output * 1600) / 1e9;
        }
        if (provider === 'gemini') {
          const input = Number(usage.inputTokens || 0);
          const output = Number(usage.outputTokens || 0);
          return (input * 1500 + output * 9000) / 1e9;
        }
      }

      if (modality === 'image') {
        if (provider === 'openai') {
          const input = Number(usage.inputTokens || usage.inputTextTokens || 0);
          const output = Number(usage.outputTokens || usage.outputImageTokens || 0);
          return (input * 5000 + output * 40000) / 1e9;
        }
        if (provider === 'gemini') {
          const input = Number(usage.inputTokens || 0);
          const text = Number(usage.outputTextOrThinkingTokens || 0);
          const img = Number(usage.outputImageTokens || 0);
          return (input * 500 + text * 3000 + img * 60000) / 1e9;
        }
        if (provider === 'dezgo') {
          const steps = Number(usage.steps || 25);
          const images = Number(usage.images || 1);
          return (0.0181 * steps / 30) * images;
        }
      }

      if (modality === 'audio') {
        if (provider === 'elevenlabs') {
          const chars = Number(usage.characters || 0);
          return (chars / 1000) * 0.15;
        }
        if (provider === 'piper') {
          const bytes = Number(usage.outputBytes || 0);
          const seconds = bytes / 44100;
          return (seconds / 100) * 0.01;
        }
        if (provider === 'spark') {
          const bytes = Number(usage.outputBytes || 0);
          const seconds = bytes / 48000;
          return (seconds / 100) * 0.05;
        }
      }

      if (modality === 'video') {
        if (provider === 'ltx') {
          const videos = Number(usage.videos || 1);
          return videos * 0.015;
        }
      }

      return 0;
    }

    const estimatedPrices = [
      {
        provider: 'elevenlabs',
        modality: 'audio',
        model: 'eleven_turbo_v2_5',
        rate: '$0.15 per 1,000 characters',
        notes: 'Runs via ElevenLabs API (Starter/Creator tier average)',
      },
      {
        provider: 'piper',
        modality: 'audio',
        model: 'piper-local',
        rate: '$0.01 per 100 seconds of audio ($0.0001/sec)',
        notes: 'Runs locally or via Modal.com CPU/GPU container',
      },
      {
        provider: 'spark',
        modality: 'audio',
        model: 'spark-tts',
        rate: '$0.05 per 100 seconds of audio ($0.0005/sec)',
        notes: 'Runs locally or via Modal.com container',
      },
      {
        provider: 'ltx',
        modality: 'video',
        model: 'ltx-video',
        rate: '$0.015 per generation (approx. 5s at 24fps)',
        notes: 'Runs locally or via Modal.com A100 GPU instance',
      }
    ];

    function localJsonSafe(value) {
      if (typeof value === 'bigint') return value.toString();
      if (value instanceof Date) return value.toISOString();
      if (Array.isArray(value)) return value.map(localJsonSafe);
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value).map(([key, val]) => [key, localJsonSafe(val)])
        );
      }
      return value;
    }

    const providers = {};
    let totalCostUSD = 0;
    let totalTokens = 0;

    for (const event of events) {
      const provider = event.provider || 'unknown';
      const modality = event.modality || 'unknown';
      const model = event.model || 'unknown';

      if (!providers[provider]) {
        providers[provider] = {
          costUSD: 0,
          tokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          modalities: {},
        };
      }

      const usage = event.usage || {};
      const input = Number(usage.inputTokens || usage.inputTextTokens || 0);
      const output = Number(usage.outputTokens || usage.candidatesTokenCount || usage.thoughtsTokenCount || usage.outputImageTokens || 0);
      const tokens = Number(usage.totalTokens || usage.totalTokenCount || 0) || (input + output);

      let costUSD = 0;
      if (event.costSnapshot) {
        costUSD = Number(event.costSnapshot.providerCostNanoUsd) / 1e9;
      } else {
        costUSD = estimateUsageCost(event);
      }

      providers[provider].costUSD += costUSD;
      providers[provider].tokens += tokens;
      providers[provider].inputTokens += input;
      providers[provider].outputTokens += output;

      if (!providers[provider].modalities[modality]) {
        providers[provider].modalities[modality] = {
          costUSD: 0,
          tokens: 0,
          count: 0,
          models: {},
        };
      }

      const modalityGroup = providers[provider].modalities[modality];
      modalityGroup.costUSD += costUSD;
      modalityGroup.tokens += tokens;

      if (!modalityGroup.models[model]) {
        modalityGroup.models[model] = {
          costUSD: 0,
          tokens: 0,
          count: 0,
          inputTokens: 0,
          outputTokens: 0,
          extra: {},
        };
      }

      const modelGroup = modalityGroup.models[model];
      modelGroup.costUSD += costUSD;
      modelGroup.tokens += tokens;
      modelGroup.inputTokens += input;
      modelGroup.outputTokens += output;

      if (modality === 'text') {
        modalityGroup.count += 1;
        modelGroup.count += 1;
      } else if (modality === 'image') {
        const count = Number(usage.images || 1);
        modalityGroup.count += count;
        modelGroup.count += count;
      } else if (modality === 'audio') {
        const count = Number(usage.characters || 0);
        modalityGroup.count += count;
        modelGroup.count += count;
        modelGroup.extra.bytes = (modelGroup.extra.bytes || 0) + Number(usage.outputBytes || 0);
      } else if (modality === 'video') {
        const count = Number(usage.videos || 1);
        modalityGroup.count += count;
        modelGroup.count += count;
        const frames = Number(usage.frames || 0);
        modelGroup.extra.frames = (modelGroup.extra.frames || 0) + frames;
      }

      totalCostUSD += costUSD;
      totalTokens += tokens;
    }

    res.json({
      ok: true,
      totalCostUSD,
      totalTokens,
      providers,
      activePrices: localJsonSafe(activePrices),
      estimatedPrices,
    });
  }));
  router.put('/:projectId', validate(projectDocument), asyncRoute(async (req, res) => {
    const header = req.get('If-Match');
    const expectedRevision = header ? Number(String(header).replace(/^W\/|"/g, '').replace(/"$/, '')) : req.body.revision;
    if (!Number.isInteger(expectedRevision)) throw new AppError('REVISION_REQUIRED', 'If-Match or a numeric revision is required', { status: 428 });
    const project = await store.write(req.params.projectId, req.body, { expectedRevision, ownerId: req.auth.tenantId });
    res.set('ETag', `"${project.revision}"`).json({ ok: true, project });
  }));
  router.delete('/:projectId', asyncRoute(async (req, res) => {
    await store.read(req.params.projectId, { ownerId: req.auth.tenantId });
    await queue.cancelProject(req.params.projectId);
    await store.delete(req.params.projectId, { ownerId: req.auth.tenantId });
    res.status(204).end();
  }));

  return router;
}

module.exports = { createProjectRouter };
