const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ProjectStore } = require('../src/storage/project-store');
const { createShotReferenceService } = require('../src/services/shot-reference.service');
const { createTextProviders } = require('../src/providers/text');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reference-roles-'));
  return {
    root,
    config: { paths: { generated: path.join(root, 'generated') } },
    store: new ProjectStore(path.join(root, 'projects')),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('legacy scene references adapt to composition while explicit roles survive persistence', async () => {
  const f = fixture();
  try {
    f.store.create({ id: 'project', project: { scenes: [{ id: 'scene-1', referenceImages: [{ path: '/legacy.png' }] }] } });
    assert.equal(f.store.read('project').scenes[0].referenceImages[0].role, 'composition');

    const service = createShotReferenceService({ config: f.config, projectStore: f.store });
    const uploaded = await service.upload('project', 'scene-1', [{
      originalname: 'hero.png', mimetype: 'image/png',
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    }]);
    const reference = uploaded.scene.referenceImages.find((item) => item.fileName === 'hero.png');
    assert.equal(reference.role, 'composition');

    const changed = await service.setRole('project', 'scene-1', reference.path, 'character');
    assert.equal(changed.scene.referenceImages.find((item) => item.path === reference.path).role, 'character');
    assert.equal(f.store.read('project').scenes[0].referenceImages.find((item) => item.path === reference.path).role, 'character');
    await assert.rejects(() => service.setRole('project', 'scene-1', reference.path, 'product'), (error) => error.code === 'INVALID_REFERENCE_ROLE');
  } finally {
    f.cleanup();
  }
});

test('Gemini reference parts label each supported role with a distinct instruction', () => {
  const f = fixture();
  try {
    const files = ['character', 'location', 'composition', 'continuity'].map((role) => {
      const file = path.join(f.root, `${role}.png`);
      fs.writeFileSync(file, role);
      return { path: file, role };
    });
    const providers = createTextProviders({ env: {} }, () => null);
    const parts = providers.geminiParts('Create a shot.', files);
    const labels = parts.filter((part) => part.text).map((part) => part.text);

    assert.equal(parts.filter((part) => part.inline_data).length, 4);
    assert.match(labels[1], /CHARACTER IDENTITY/);
    assert.match(labels[2], /LOCATION IDENTITY/);
    assert.match(labels[3], /COMPOSITION/);
    assert.match(labels[4], /PREVIOUS SHOT CONTINUITY/);
    assert.doesNotMatch(labels.slice(1).join('\n'), /^Reference image$/m);
  } finally {
    f.cleanup();
  }
});
