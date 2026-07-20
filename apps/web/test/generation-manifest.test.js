const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { ProjectStore } = require('../src/storage/project-store');
const { createGenerationManifest, hashCanonical } = require('../src/shared/generation-manifest');
const { providerResult } = require('../src/providers/result');
const { createImageGenerationService } = require('../src/services/image-generation.service');
const { createVideoGenerationService } = require('../src/services/video-generation.service');
const { createVideoProviders } = require('../src/providers/video');
const { createVideoExecutionService } = require('../src/services/video-execution.service');
const { createLocalVideoAssetTransport } = require('../src/providers/video/asset-transport');
const { VideoGenerationAttemptStore } = require('../src/storage/video-generation-attempt-store');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'generation-manifest-'));
  const config = {
    env: {},
    videoProvider: 'ltx',
    paths: {
      generated: path.join(root, 'generated'),
      videos: path.join(root, 'videos'),
    },
  };
  return {
    root,
    config,
    store: new ProjectStore(path.join(root, 'projects')),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('manifest hashing is canonical and snapshots mutable inputs', async () => {
  const inputs = { provider: { name: 'gemini' }, prompt: { scene: 'Door' }, references: [] };
  const manifest = createGenerationManifest({ modality: 'image', inputs });
  inputs.prompt.scene = 'Changed after creation';

  assert.equal(manifest.inputs.prompt.scene, 'Door');
  assert.equal(manifest.manifestHash, hashCanonical(manifest.inputs));
  assert.equal(hashCanonical({ b: 2, a: 1 }), hashCanonical({ a: 1, b: 2 }));
  assert.notEqual(hashCanonical({ a: 1 }), hashCanonical({ a: 2 }));

  const browser = await import(path.join(__dirname, '..', 'public', 'modules', 'generation-manifest.js'));
  assert.equal(browser.hashCanonical(manifest.inputs), manifest.manifestHash, 'browser and server hashes must agree');
});

test('image versions record resolved provider, settings, references, and provider-limit omissions', async () => {
  const f = fixture();
  try {
    f.store.create({ id: 'image-project', project: { scenes: [{ id: 'scene-1' }] } });
    const firstReference = path.join(f.root, 'character.png');
    const secondReference = path.join(f.root, 'location.png');
    fs.writeFileSync(firstReference, 'character');
    fs.writeFileSync(secondReference, 'location');
    let receivedReferences;
    let receivedBindings;
    let providerCalls = 0;
    const service = createImageGenerationService({
      config: f.config,
      projectStore: f.store,
      styles: {
        find: () => ({ id: 'style-1', promptText: 'Ink style.' }),
        referenceSources: () => [
          { path: firstReference, url: '/style-references/style-1/characters/character.png', type: 'characters' },
          { path: secondReference, url: '/style-references/style-1/world/location.png', type: 'world' },
        ],
      },
      provider: {
        generate: async ({ references, referenceBindings }) => {
          providerCalls += 1;
          receivedReferences = references;
          receivedBindings = referenceBindings;
          return providerResult({
            output: { buffer: Buffer.from('image'), mimeType: 'image/png', extension: 'png' },
            provider: 'dezgo', model: 'flux-test', providerRequestId: 'request-image',
            settings: { mode: 'image_to_image', strength: 0.65 }, measurementStatus: 'observed',
          });
        },
      },
    });

    const input = {
      projectId: 'image-project', sceneId: 'scene-1', sceneNumber: 1, sceneTitle: 'One',
      scenePrompt: 'Mara opens the door.', styleId: 'style-1', commonPromptText: 'Ink style. Readable silhouette.',
      extraPromptText: '', provider: 'dezgo',
    };
    const preflight = await service.preflight(input);
    assert.equal(preflight.requiresConfirmation, true);
    assert.equal(preflight.referenceCount, 1);
    assert.equal(preflight.omittedReferenceCount, 1);
    await assert.rejects(() => service.generate(input), (error) => {
      assert.equal(error.code, 'REFERENCE_OMISSIONS_CONFIRMATION_REQUIRED');
      return true;
    });
    assert.equal(providerCalls, 0, 'unconfirmed omissions must stop before provider submission');
    const result = await service.generate({ ...input, confirmedReferencePlanHash: preflight.referencePlanHash });
    assert.equal(providerCalls, 1);
    const version = result.scene.shots[0].versions[0];

    assert.deepEqual(receivedReferences, [firstReference]);
    assert.deepEqual(receivedBindings, [{ path: firstReference, role: 'character', source: 'style' }]);
    assert.equal(version.manifestHash, version.manifest.manifestHash);
    assert.equal(version.manifest.inputs.provider.model, 'flux-test');
    assert.equal(version.manifest.inputs.settings.strength, 0.65);
    assert.deepEqual(version.manifest.inputs.settings.output.requested, { aspectRatio: '1:1', quality: 'medium', resolutionTier: 'standard' });
    assert.equal(version.manifest.inputs.settings.output.resolved.width, 1024);
    assert.deepEqual(version.manifest.inputs.references, [{ consumed: true, order: 0, path: '/style-references/style-1/characters/character.png', providerSlot: 'init_image', role: 'character', source: 'style' }]);
    assert.deepEqual(version.manifest.omissions, [{ order: 1, path: '/style-references/style-1/world/location.png', reason: 'provider_limit', role: 'location', source: 'style' }]);
    assert.equal(result.referencePlan.transport, 'image_to_image_anchor');
    assert.equal(result.referencePlan.included[0].providerSlot, 'init_image');
    assert.equal(result.referencePlan.excluded[0].reason, 'provider_limit');
    assert.equal(version.manifest.result.providerRequestId, 'request-image');
  } finally {
    f.cleanup();
  }
});

test('video versions record the start frame and exact provider settings', async () => {
  const f = fixture();
  try {
    let project = f.store.create({ id: 'video-project', project: { scenes: [{ id: 'scene-1' }] } });
    const source = path.join(f.root, 'source.png');
    const endSource = path.join(f.root, 'end.png');
    fs.writeFileSync(source, 'image');
    fs.writeFileSync(endSource, 'ending');
    const image = f.store.commitAsset(f.store.acquireLease('video-project'), 'images', source);
    const endImage = f.store.commitAsset(f.store.acquireLease('video-project'), 'images', endSource);
    project = f.store.write('video-project', {
      ...project,
      scenes: [{
        ...project.scenes[0],
        shots: [{
          ...project.scenes[0].shots[0],
          versions: [{ path: image.path }, { path: endImage.path }],
          activeVersionIndex: 0,
          startFrame: image.path,
          endFrame: endImage.path,
        }],
      }],
    }, { expectedRevision: project.revision });
    let received;
    const service = createVideoGenerationService({
      config: f.config,
      projectStore: f.store,
      styles: { find: () => ({ id: 'style-1', promptText: 'Ink style.' }) },
      provider: {
        verify: async () => ({ ok: true }),
        generate: async (input) => {
          received = input;
          const { outputPath } = input;
          fs.writeFileSync(outputPath, 'video');
          return providerResult({
            output: { outputPath }, provider: 'ltx', model: 'ltx-test', providerRequestId: 'request-video',
            settings: { width: 640, height: 480, seed: 42 }, measurementStatus: 'observed',
          });
        },
      },
    });

    const result = await service.generate({
      projectId: 'video-project', sceneId: 'scene-1', sceneNumber: 1, sceneTitle: 'One',
      scenePrompt: 'Mara at the door.', sceneBeat: 'Mara opens the door.', styleId: 'style-1',
      commonPromptText: 'Ink style.', motionIntensity: 'high',
    });
    const version = result.scene.shots[0].videoVersions[0];

    assert.deepEqual(version.manifest.inputs.sourceAssets, [
      { consumed: true, path: image.path, role: 'start_frame', sha256: crypto.createHash('sha256').update('image').digest('hex') },
      { consumed: false, path: endImage.path, role: 'end_frame', sha256: crypto.createHash('sha256').update('ending').digest('hex') },
    ]);
    assert.equal(received.startFramePath, image.sourcePath);
    assert.equal(Object.hasOwn(received, 'endFramePath'), false, 'LTX must not receive an unsupported end frame');
    assert.equal(version.manifest.inputs.provider.model, 'ltx-test');
    assert.equal(version.manifest.inputs.settings.motionIntensity, 'high');
    assert.equal(version.manifest.inputs.settings.seed, 42);
    assert.deepEqual(version.manifest.inputs.settings.output.requested, { aspectRatio: '4:3', resolutionTier: 'draft' });
    assert.deepEqual([version.manifest.inputs.settings.output.resolved.width, version.manifest.inputs.settings.output.resolved.height], [640, 480]);
    assert.equal(version.manifest.result.providerRequestId, 'request-video');
    assert.equal(version.manifestHash, hashCanonical(version.manifest.inputs));
  } finally {
    f.cleanup();
  }
});

test('project-level media settings choose the default video provider, and an explicit request still overrides it', async () => {
  const f = fixture();
  try {
    f.config.paths.stubs = path.join(f.root, 'stubs');
    f.config.paths.ltxShared = path.join(f.root, 'ltx');
    let project = f.store.create({ id: 'provider-project', project: { scenes: [{ id: 'scene-1' }] } });
    const source = path.join(f.root, 'source.png');
    fs.writeFileSync(source, 'image');
    const image = f.store.commitAsset(f.store.acquireLease('provider-project'), 'images', source);
    project = f.store.write('provider-project', {
      ...project,
      mediaSettings: { video: { resolutionTier: 'draft', provider: 'stub' } },
      scenes: [{
        ...project.scenes[0],
        shots: [{ ...project.scenes[0].shots[0], versions: [{ path: image.path }], activeVersionIndex: 0, startFrame: image.path }],
      }],
    }, { expectedRevision: project.revision });

    const calls = [];
    const spyAdapter = (name) => ({
      name, model: `${name}-model`,
      async verify() { return { ok: true }; },
      async prepareAssets(request, transport) { return { ...request, preparedInputs: await Promise.all(request.inputPlan.included.map((input) => transport.prepareInput(input))), outputTransport: await transport.prepareOutput(request) }; },
      async submit(request) {
        calls.push(name);
        fs.writeFileSync(request.outputPath, 'video');
        return { provider: name, model: `${name}-model`, state: 'completed', providerTaskId: null, response: { output: { outputPath: request.outputPath }, provider: name, model: `${name}-model`, settings: {}, usage: { videos: 1 }, measurementStatus: 'not_applicable' } };
      },
      async inspect(task) { return task; },
      async cancel(task) { return { ...task, state: 'cancelled' }; },
      async fetchResult(task) { return task.response; },
      normalizeUsage(response) { return response; },
    });
    const providers = createVideoProviders(f.config, () => null, null, { ltx: spyAdapter('ltx'), stub: spyAdapter('stub') });
    const execution = createVideoExecutionService({ providers, attempts: new VideoGenerationAttemptStore(path.join(f.root, 'attempts')), assetTransport: createLocalVideoAssetTransport() });
    const service = createVideoGenerationService({ config: f.config, providers, execution, projectStore: f.store, styles: { find: () => ({ id: 'style-1', promptText: 'Ink style.' }) } });

    const baseInput = { projectId: 'provider-project', sceneId: 'scene-1', sceneNumber: 1, sceneTitle: 'One', scenePrompt: 'Mara at the door.', sceneBeat: 'Mara opens the door.', styleId: 'style-1', commonPromptText: 'Ink style.', motionIntensity: 'medium' };

    const defaulted = await service.generate({ ...baseInput });
    assert.equal(defaulted.video.provider, 'stub', 'no explicit provider must fall back to the project default');

    const overridden = await service.generate({ ...baseInput, provider: 'ltx' });
    assert.equal(overridden.video.provider, 'ltx', 'an explicit request provider must still win over the project default');

    assert.deepEqual(calls, ['stub', 'ltx']);
  } finally {
    f.cleanup();
  }
});
