const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ProjectStore } = require('../src/storage/project-store');
const { createGenerationManifest, hashCanonical } = require('../src/shared/generation-manifest');
const { providerResult } = require('../src/providers/result');
const { createImageGenerationService } = require('../src/services/image-generation.service');
const { createVideoGenerationService } = require('../src/services/video-generation.service');

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

    const result = await service.generate({
      projectId: 'image-project', sceneId: 'scene-1', sceneNumber: 1, sceneTitle: 'One',
      scenePrompt: 'Mara opens the door.', styleId: 'style-1', commonPromptText: 'Ink style. Readable silhouette.',
      extraPromptText: '', provider: 'dezgo',
    });
    const version = result.scene.shots[0].versions[0];

    assert.deepEqual(receivedReferences, [firstReference]);
    assert.deepEqual(receivedBindings, [{ path: firstReference, role: 'character', source: 'style' }]);
    assert.equal(version.manifestHash, version.manifest.manifestHash);
    assert.equal(version.manifest.inputs.provider.model, 'flux-test');
    assert.equal(version.manifest.inputs.settings.strength, 0.65);
    assert.deepEqual(version.manifest.inputs.references, [{ consumed: true, order: 0, path: '/style-references/style-1/characters/character.png', role: 'character', source: 'style' }]);
    assert.deepEqual(version.manifest.omissions, [{ order: 1, path: '/style-references/style-1/world/location.png', reason: 'provider_limit', role: 'location', source: 'style' }]);
    assert.equal(version.manifest.result.providerRequestId, 'request-image');
  } finally {
    f.cleanup();
  }
});

test('video versions record the start frame and exact provider settings', async () => {
  const f = fixture();
  try {
    f.store.create({ id: 'video-project', project: { scenes: [{ id: 'scene-1' }] } });
    const source = path.join(f.root, 'source.png');
    fs.writeFileSync(source, 'image');
    const image = f.store.commitAsset(f.store.acquireLease('video-project'), 'images', source);
    const service = createVideoGenerationService({
      config: f.config,
      projectStore: f.store,
      styles: { find: () => ({ id: 'style-1', promptText: 'Ink style.' }) },
      provider: {
        verify: async () => ({ ok: true }),
        generate: async ({ outputPath }) => {
          fs.writeFileSync(outputPath, 'video');
          return providerResult({
            output: { outputPath }, provider: 'ltx', model: 'ltx-test', providerRequestId: 'request-video',
            settings: { width: 640, height: 480, seed: 42 }, measurementStatus: 'observed',
          });
        },
      },
    });

    const result = await service.generate({
      projectId: 'video-project', sceneId: 'scene-1', sceneNumber: 1, sceneTitle: 'One', imagePath: image.path,
      scenePrompt: 'Mara at the door.', sceneBeat: 'Mara opens the door.', styleId: 'style-1',
      commonPromptText: 'Ink style.', motionIntensity: 'high',
    });
    const version = result.scene.shots[0].videoVersions[0];

    assert.deepEqual(version.manifest.inputs.sourceAssets, [{ path: image.path, role: 'start_frame' }]);
    assert.equal(version.manifest.inputs.provider.model, 'ltx-test');
    assert.equal(version.manifest.inputs.settings.motionIntensity, 'high');
    assert.equal(version.manifest.inputs.settings.seed, 42);
    assert.equal(version.manifest.result.providerRequestId, 'request-video');
    assert.equal(version.manifestHash, hashCanonical(version.manifest.inputs));
  } finally {
    f.cleanup();
  }
});
