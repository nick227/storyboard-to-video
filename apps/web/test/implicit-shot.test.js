const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ProjectStore } = require('../src/storage/project-store');
const { createExportService } = require('../src/services/export.service');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'implicit-shot-'));
  const projects = path.join(root, 'projects');
  return {
    root,
    store: new ProjectStore(projects),
    config: { paths: { zips: path.join(root, 'zips') } },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function persistedProject(store, id) {
  return JSON.parse(fs.readFileSync(store.documentPath(id), 'utf8'));
}

test('legacy scene image fields migrate intact to the implicit shot and persist canonically', () => {
  const f = fixture();
  try {
    const created = f.store.create({ id: 'legacy', project: { scenes: [] } });
    const rawLegacy = JSON.parse(JSON.stringify(created));
    rawLegacy.scenes = [{
      id: 'scene-1',
      prompt: 'Legacy composition',
      versions: [{ path: '/one.png' }, { path: '/two.png' }],
      activeVersionIndex: 1,
      videoVersions: [{ path: '/one.mp4', sourceImagePath: '/two.png' }, { path: '/two.mp4', sourceImagePath: '/two.png' }],
      activeVideoVersionIndex: 1,
      referenceImages: [{ path: '/character.png', name: 'Character' }],
      disabledProjectReferenceImages: ['/style.png'],
    }];
    fs.writeFileSync(f.store.documentPath('legacy'), JSON.stringify(rawLegacy));

    const loaded = f.store.read('legacy');
    assert.equal(loaded.scenes[0].shots[0].prompt, 'Legacy composition');
    assert.deepEqual(loaded.scenes[0].shots[0].versions, rawLegacy.scenes[0].versions);
    assert.equal(loaded.scenes[0].shots[0].activeVersionIndex, 1);
    assert.deepEqual(loaded.scenes[0].shots[0].videoVersions, rawLegacy.scenes[0].videoVersions);
    assert.equal(loaded.scenes[0].shots[0].activeVideoVersionIndex, 1);
    assert.deepEqual(loaded.scenes[0].shots[0].referenceBindings, [{ path: '/character.png', name: 'Character', role: 'composition' }]);
    assert.deepEqual(loaded.scenes[0].shots[0].disabledStyleReferencePaths, ['/style.png']);
    assert.equal(loaded.scenes[0].shots[0].startFrame, '/two.png');
    assert.equal(loaded.scenes[0].shots[0].endFrame, null);
    assert.equal(loaded.scenes[0].versions, loaded.scenes[0].shots[0].versions, 'legacy reads are projections');
    assert.equal(loaded.scenes[0].videoVersions, loaded.scenes[0].shots[0].videoVersions, 'legacy video reads are projections');

    const onDisk = persistedProject(f.store, 'legacy');
    assert.deepEqual(onDisk.scenes[0].shots[0].versions, rawLegacy.scenes[0].versions);
    assert.equal(Object.hasOwn(onDisk.scenes[0], 'prompt'), false);
    assert.equal(Object.hasOwn(onDisk.scenes[0], 'versions'), false);
    assert.equal(Object.hasOwn(onDisk.scenes[0], 'activeVersionIndex'), false);
    assert.equal(Object.hasOwn(onDisk.scenes[0], 'videoVersions'), false);
    assert.equal(Object.hasOwn(onDisk.scenes[0], 'activeVideoVersionIndex'), false);
    assert.equal(Object.hasOwn(onDisk.scenes[0], 'referenceImages'), false);
    assert.equal(Object.hasOwn(onDisk.scenes[0], 'disabledProjectReferenceImages'), false);
  } finally {
    f.cleanup();
  }
});

test('wrapped prompt and narration values migrate to text instead of object Object', () => {
  const f = fixture();
  try {
    const created = f.store.create({
      id: 'wrapped-text',
      project: { scenes: [{ id: 'scene-1', narrationText: 'Initial narration', shots: [{ prompt: 'Initial prompt' }] }] },
    });
    const raw = JSON.parse(JSON.stringify(created));
    raw.scenes[0].narrationText = { narrationText: 'Recovered narration' };
    raw.scenes[0].shots[0].prompt = { prompt: { text: 'Recovered prompt' } };
    fs.writeFileSync(f.store.documentPath('wrapped-text'), JSON.stringify(raw));

    const loaded = f.store.read('wrapped-text');
    assert.equal(loaded.scenes[0].narrationText, 'Recovered narration');
    assert.equal(loaded.scenes[0].prompt, 'Recovered prompt');
    const persisted = persistedProject(f.store, 'wrapped-text');
    assert.equal(persisted.scenes[0].narrationText, 'Recovered narration');
    assert.equal(persisted.scenes[0].shots[0].prompt, 'Recovered prompt');
  } finally {
    f.cleanup();
  }
});

test('new writes and regenerated image versions use shots[0] as the sole persisted owner', () => {
  const f = fixture();
  try {
    f.store.create({
      id: 'canonical',
      project: { scenes: [{ id: 'scene-1', shots: [{ prompt: 'Canonical prompt', versions: [], activeVersionIndex: 0 }] }] },
    });
    const lease = f.store.acquireLease('canonical');
    f.store.attachSceneVersion(lease, {
      sceneId: 'scene-1', kind: 'image', jobId: 'first', version: { path: '/first.png' },
    });
    const regenerated = f.store.attachSceneVersion(lease, {
      sceneId: 'scene-1', kind: 'image', jobId: 'second', version: { path: '/second.png' },
    });

    assert.deepEqual(regenerated.scene.shots[0].versions.map((version) => version.jobId), ['first', 'second']);
    assert.equal(regenerated.scene.shots[0].activeVersionIndex, 1);
    assert.equal(regenerated.scene.shots[0].startFrame, '/first.png', 'new active versions do not overwrite the selected start frame');
    assert.equal(regenerated.scene.shots[0].endFrame, null);

    const reloaded = f.store.read('canonical');
    assert.equal(reloaded.scenes[0].shots[0].prompt, 'Canonical prompt');
    assert.equal(reloaded.scenes[0].shots[0].versions.length, 2);
    assert.equal(reloaded.scenes[0].shots[0].activeVersionIndex, 1);
    assert.equal(Object.hasOwn(persistedProject(f.store, 'canonical').scenes[0], 'versions'), false);
  } finally {
    f.cleanup();
  }
});

test('new video generations append to shots[0] and survive reload without dual-writing', () => {
  const f = fixture();
  try {
    f.store.create({
      id: 'canonical-video',
      project: { scenes: [{ id: 'scene-1', shots: [{ prompt: '', versions: [{ path: '/image.png' }], activeVersionIndex: 0 }] }] },
    });
    const lease = f.store.acquireLease('canonical-video');
    f.store.attachSceneVersion(lease, {
      sceneId: 'scene-1', kind: 'video', jobId: 'first-video', version: { path: '/first.mp4', sourceImagePath: '/image.png' },
    });
    const regenerated = f.store.attachSceneVersion(lease, {
      sceneId: 'scene-1', kind: 'video', jobId: 'second-video', version: { path: '/second.mp4', sourceImagePath: '/image.png' },
    });

    assert.deepEqual(regenerated.scene.shots[0].videoVersions.map((version) => version.jobId), ['first-video', 'second-video']);
    assert.equal(regenerated.scene.shots[0].activeVideoVersionIndex, 1);
    assert.equal(regenerated.scene.activeVisualType, 'video');

    const reloaded = f.store.read('canonical-video');
    assert.equal(reloaded.scenes[0].shots[0].videoVersions.length, 2);
    assert.equal(reloaded.scenes[0].shots[0].activeVideoVersionIndex, 1);
    const onDisk = persistedProject(f.store, 'canonical-video').scenes[0];
    assert.equal(Object.hasOwn(onDisk, 'videoVersions'), false);
    assert.equal(Object.hasOwn(onDisk, 'activeVideoVersionIndex'), false);
  } finally {
    f.cleanup();
  }
});

test('active image switching updates shots[0] and serialization omits compatibility fields', async () => {
  const helpers = await import(path.join(__dirname, '..', 'public', 'js', 'core', 'scene-shots.js'));
  const scene = helpers.adaptSceneImageShot({
    id: 'scene-1',
    prompt: 'Legacy prompt',
    versions: [{ path: '/first.png' }, { path: '/second.png' }],
    activeVersionIndex: 0,
  });

  helpers.setActiveImageVersion(scene, 1);
  assert.equal(scene.shots[0].activeVersionIndex, 1);
  assert.equal(scene.activeVersionIndex, 1, 'unchanged UI reads see the compatibility projection');
  assert.deepEqual(JSON.parse(JSON.stringify(scene)), {
    id: 'scene-1',
    shots: [{
      prompt: 'Legacy prompt',
      versions: [{ path: '/first.png' }, { path: '/second.png' }],
      activeVersionIndex: 1,
      videoVersions: [],
      activeVideoVersionIndex: 0,
      referenceBindings: [],
      disabledStyleReferencePaths: [],
      startFrame: '/first.png',
      endFrame: null,
      videoKeyframeSelection: null,
    }],
  });
});

test('active video switching updates shots[0] while legacy reads remain compatible', async () => {
  const helpers = await import(path.join(__dirname, '..', 'public', 'js', 'core', 'scene-shots.js'));
  const scene = helpers.adaptSceneImageShot({
    id: 'scene-1',
    shots: [{
      prompt: '', versions: [{ path: '/image.png' }], activeVersionIndex: 0,
      videoVersions: [{ path: '/first.mp4' }, { path: '/second.mp4' }], activeVideoVersionIndex: 0,
    }],
  });

  helpers.setActiveVideoVersion(scene, 1);
  assert.equal(scene.shots[0].activeVideoVersionIndex, 1);
  assert.equal(scene.activeVideoVersionIndex, 1);
  const serialized = JSON.parse(JSON.stringify(scene));
  assert.equal(serialized.shots[0].activeVideoVersionIndex, 1);
  assert.equal(Object.hasOwn(serialized, 'videoVersions'), false);
});

test('start and end frame selections reference image versions without duplicating assets', async () => {
  const helpers = await import(path.join(__dirname, '..', 'public', 'js', 'core', 'scene-shots.js'));
  const scene = helpers.adaptSceneImageShot({
    id: 'scene-1',
    versions: [{ path: '/first.png' }, { path: '/second.png' }],
    activeVersionIndex: 0,
  });

  helpers.setStartFrame(scene, '/second.png');
  helpers.setEndFrame(scene, '/first.png');
  assert.equal(scene.shots[0].startFrame, '/second.png');
  assert.equal(scene.shots[0].endFrame, '/first.png');
  assert.equal(scene.shots[0].videoKeyframeSelection, null, 'direct frame mutations are not treated as video-confirmed keyframes');
  assert.equal(scene.shots[0].versions.length, 2);
  assert.throws(() => helpers.setEndFrame(scene, '/not-a-version.png'), /must reference an image version/);

  helpers.setVideoKeyframes(scene, '/first.png', '/second.png');
  assert.equal(scene.shots[0].videoKeyframeSelection.source, 'video_generation_confirmation');
  assert.equal(scene.shots[0].videoKeyframeSelection.endFrame, '/second.png');
  assert.throws(() => helpers.setVideoKeyframes(scene, '/first.png', '/first.png'), /must be different/);
});

test('ZIP export resolves the active image and video from shots[0]', async () => {
  const f = fixture();
  try {
    let project = f.store.create({ id: 'export', project: { scenes: [{ id: 'scene-1' }] } });
    const lease = f.store.acquireLease('export');
    const firstSource = path.join(f.root, 'first.png');
    const secondSource = path.join(f.root, 'second.png');
    const firstVideoSource = path.join(f.root, 'first.mp4');
    const secondVideoSource = path.join(f.root, 'second.mp4');
    fs.writeFileSync(firstSource, 'first');
    fs.writeFileSync(secondSource, 'second');
    fs.writeFileSync(firstVideoSource, 'first video');
    fs.writeFileSync(secondVideoSource, 'second video');
    const first = await f.store.commitAsset(lease, 'images', firstSource);
    const second = await f.store.commitAsset(lease, 'images', secondSource);
    const firstVideo = await f.store.commitAsset(lease, 'videos', firstVideoSource);
    const secondVideo = await f.store.commitAsset(lease, 'videos', secondVideoSource);
    project = f.store.write('export', {
      ...project,
      scenes: [{
        id: 'scene-1', title: 'One',
        shots: [{
          prompt: '', versions: [{ path: first.path }, { path: second.path }], activeVersionIndex: 1,
          videoVersions: [{ path: firstVideo.path }, { path: secondVideo.path }], activeVideoVersionIndex: 1,
        }],
      }],
    }, { expectedRevision: project.revision });

    const resolved = [];
    const originalResolve = f.store.resolveAsset.bind(f.store);
    f.store.resolveAsset = async (...args) => {
      resolved.push(args[1]);
      return originalResolve(...args);
    };
    await createExportService({ config: f.config, projectStore: f.store }).generate('export');
    assert.deepEqual(resolved, [second.path, secondVideo.path]);
  } finally {
    f.cleanup();
  }
});
