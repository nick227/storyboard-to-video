// Replan (a destructive structural rebuild) must retire media tied to replaced scenes without
// sweeping up an asset still referenced elsewhere in the live document — cleanup() is the existing
// endpoint this relies on (POST /:projectId/cleanup, called by stages.js's replanStory only AFTER
// the rebuilt document write is confirmed — see project-store.js's write()/collectReferences()).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ProjectStore } = require('../src/storage/project-store');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'replan-cleanup-'));
  const store = new ProjectStore(path.join(root, 'projects'));
  return { root, store, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function writeImageAsset(store, projectId, ownerId, fileName, contents) {
  const staged = path.join(store.root, '..', `staged-${fileName}`);
  fs.writeFileSync(staged, contents);
  const lease = store.acquireLease(projectId, { ownerId });
  return store.commitAsset(lease, 'images', staged, { fileName });
}

test('replan cleanup: an asset only tied to a replaced scene is retired, but an asset still referenced by a surviving scene is not', async () => {
  const { store, cleanup } = fixture();
  try {
    const ownerId = 'owner-1';
    const project = store.create({ id: 'replan-test-project', title: 'Replan Test' }, { ownerId, tenantId: ownerId });

    const assetA = await writeImageAsset(store, project.id, ownerId, 'scene-a.png', 'scene-a-image-bytes');
    const assetB = await writeImageAsset(store, project.id, ownerId, 'scene-b.png', 'scene-b-image-bytes');

    // Attach both as real scene versions in the live document (this is the state before a replan:
    // two scenes, each with a generated image).
    let document = store.read(project.id, { ownerId });
    document.scenes = [
      { id: 'scene-a', title: 'Scene A', versions: [{ path: assetA.path, prompt: 'a' }], activeVersionIndex: 0 },
      { id: 'scene-b', title: 'Scene B', versions: [{ path: assetB.path, prompt: 'b' }], activeVersionIndex: 0 },
    ];
    document = store.write(project.id, document, { expectedRevision: document.revision, ownerId });

    // Both asset files exist on disk before the replan.
    const imagesDir = store.assetDir(project.id, 'images');
    assert.ok(fs.existsSync(path.join(imagesDir, assetA.fileName)));
    assert.ok(fs.existsSync(path.join(imagesDir, assetB.fileName)));

    // Simulate a Replan: scene A is replaced by a brand-new scene structure (fresh id, no image
    // yet); scene B survives, unchanged, keeping its existing image reference — exactly the "surviving
    // scene ids retain reusable artifacts where valid" behavior the plan calls for.
    document = store.read(project.id, { ownerId });
    document.scenes = [
      { id: 'scene-a-rebuilt', title: 'Scene A (rebuilt)', versions: [], activeVersionIndex: 0 },
      { id: 'scene-b', title: 'Scene B', versions: [{ path: assetB.path, prompt: 'b' }], activeVersionIndex: 0 },
    ];
    document = store.write(project.id, document, { expectedRevision: document.revision, ownerId });

    // Per the plan's ordering requirement: cleanup only happens AFTER this rebuild write already
    // succeeded and is the confirmed, authoritative document (which it now is, at this point).
    const moved = await store.cleanup(project.id, { ownerId });

    assert.ok(moved.some((item) => item.fileName === assetA.fileName), 'the orphaned scene-a image must be retired by cleanup');
    assert.ok(!moved.some((item) => item.fileName === assetB.fileName), 'the still-referenced scene-b image must NOT be swept up by cleanup');
    assert.ok(!fs.existsSync(path.join(imagesDir, assetA.fileName)), 'scene-a image file must be gone from the live asset directory');
    assert.ok(fs.existsSync(path.join(imagesDir, assetB.fileName)), 'scene-b image file must still be present — cleanup must not delete a still-live shared/reference asset');
  } finally {
    cleanup();
  }
});
