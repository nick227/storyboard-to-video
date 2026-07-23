const express = require('express');
const { createProject, projectDocument } = require('../schemas');
const { validate } = require('../middleware/validate');
const { AppError } = require('../errors');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { imageShot } = require('../shared/scene-shots');
const { mergeMediaIntent, resolveImageOutput } = require('../shared/media-output-policy');
const { VIDEO_PROVIDER_CAPABILITIES } = require('../shared/video-provider-capabilities');
const { dezgoModelForProvider, isDezgoProvider } = require('../providers/image/dezgo-settings');

function createProjectRouter({ store, queue, upload, shotReferences, styles, prompts, referenceGeneration, imageProvider, identityStore, prisma, config, spendSummary, scripts }) {
  const router = express.Router();
  const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

  async function attachScript(project, req) {
    if (!scripts) return project;
    const script = await scripts.ensureForProject(project, {
      tenantId: req.auth.tenantId,
      userId: req.auth.userId,
      author: req.user?.displayName,
      projectStore: store,
    });
    return { ...project, scriptId: script.id, script, scriptText: script.scriptText };
  }

  async function withCanonicalScript(project) {
    if (!scripts || !project.scriptId) return project;
    try {
      const script = await scripts.get(project.scriptId, { tenantId: project.tenantId });
      return { ...project, scriptText: script.scriptText, script };
    } catch {
      return project;
    }
  }

  router.get('/', asyncRoute(async (req, res) => {
    const projects = await store.list({ ownerId: req.auth.tenantId });
    res.json({ ok: true, projects: await Promise.all(projects.map((project) => withCanonicalScript(project))) });
  }));
  router.post('/', validate(createProject), asyncRoute(async (req, res) => {
    const mediaDefaults = identityStore?.getMediaDefaults ? await identityStore.getMediaDefaults(req.auth.userId) : null;
    const input = mediaDefaults ? { ...req.body, project: { ...(req.body.project || {}), mediaSettings: req.body.project?.mediaSettings || mediaDefaults } } : req.body;
    const created = await store.create(input, { tenantId: req.auth.tenantId, createdByUserId: req.auth.userId });
    res.status(201).json({ ok: true, project: await attachScript(created, req) });
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
    const imageModels = {
      stub: 'stub-image-v1',
      openai: config.env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
      gemini: config.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image',
      ...(isDezgoProvider(providerName) ? { [providerName]: dezgoModelForProvider(providerName) } : {}),
    };
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

  router.get('/:projectId', asyncRoute(async (req, res) => {
    const project = await withCanonicalScript(await store.read(req.params.projectId, { ownerId: req.auth.tenantId }));
    res.json({ ok: true, project });
  }));
  router.get('/:projectId/tokens', asyncRoute(async (req, res) => {
    const { projectId } = req.params;
    const videoModels = Object.entries(VIDEO_PROVIDER_CAPABILITIES).flatMap(([provider, capabilities]) =>
      Object.entries(capabilities.models).map(([model, modelCapabilities]) => ({
        provider,
        model,
        isDefault: model === capabilities.defaultModel,
        modes: Object.keys(modelCapabilities.modes).filter((mode) => modelCapabilities.modes[mode]?.implemented),
      }))
    );
    // Verify tenancy
    await store.read(projectId, { ownerId: req.auth.tenantId });

    if (!prisma || !spendSummary) {
      return res.json({ ok: true, totalCostUSD: 0, platformCostUSD: 0, totalTokens: 0, totalCredits: 0, totalCreditMicros: '0', providers: {}, activePrices: [], unpriced: [], videoModels });
    }

    const [{ providers, totalCostUSD, platformCostUSD, totalTokens, unpriced }, pricing] = await Promise.all([
      spendSummary.getProjectSpend(projectId),
      spendSummary.getActivePricing(),
    ]);
    const { credits: totalCredits, creditMicros: totalCreditMicros } = await spendSummary.withCredits(totalCostUSD);

    res.json({
      ok: true,
      totalCostUSD,
      platformCostUSD,
      totalTokens,
      totalCredits,
      totalCreditMicros: totalCreditMicros.toString(),
      providers,
      activePrices: pricing.prices,
      unpriced,
      videoModels,
    });
  }));
  router.put('/:projectId', validate(projectDocument), asyncRoute(async (req, res) => {
    const header = req.get('If-Match');
    const expectedRevision = header ? Number(String(header).replace(/^W\/|"/g, '').replace(/"$/, '')) : req.body.revision;
    if (!Number.isInteger(expectedRevision)) throw new AppError('REVISION_REQUIRED', 'If-Match or a numeric revision is required', { status: 428 });
    const project = await attachScript(
      await store.write(req.params.projectId, req.body, { expectedRevision, ownerId: req.auth.tenantId }),
      req,
    );
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
