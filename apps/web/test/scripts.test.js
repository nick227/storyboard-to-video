const test = require('node:test');
const assert = require('node:assert/strict');
const { ScriptStore } = require('../src/storage/script-store');
const { createScriptsService } = require('../src/services/scripts.service');
const { ProjectStore } = require('../src/storage/project-store');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('scripts service creates slug, publishes, and 404s private on public read', async () => {
  const store = new ScriptStore();
  const scripts = createScriptsService({ store });
  const created = await scripts.create({
    title: 'The Odyssey',
    scriptText: 'FADE IN:\n\nA wine-dark sea.',
    author: 'Homer',
  }, { tenantId: 'tenant-1', userId: 'user-1' });

  assert.equal(created.slug, 'the-odyssey');
  assert.equal(created.visibility, 'private');
  assert.equal(created.sharePath, '/scripts/the-odyssey');

  await assert.rejects(() => scripts.getPublicBySlug('the-odyssey'), (error) => error.code === 'SCRIPT_NOT_FOUND');

  const published = await scripts.setVisibility(created.id, 'public', { tenantId: 'tenant-1' });
  assert.equal(published.visibility, 'public');
  assert.ok(published.publishedAt);

  const publicScript = await scripts.getPublicBySlug('the-odyssey');
  assert.equal(publicScript.scriptText, 'FADE IN:\n\nA wine-dark sea.');
  assert.equal(publicScript.author, 'Homer');

  const listed = await scripts.listPublic();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].slug, 'the-odyssey');
  assert.equal(listed[0].scriptText, undefined);

  await scripts.setVisibility(created.id, 'private', { tenantId: 'tenant-1' });
  await assert.rejects(() => scripts.getPublicBySlug('the-odyssey'), (error) => error.code === 'SCRIPT_NOT_FOUND');
});

test('scripts service allocates unique slugs and links projects', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'script-link-'));
  try {
    const store = new ScriptStore();
    const projectStore = new ProjectStore(root);
    const scripts = createScriptsService({ store });
    const first = await scripts.create({ title: 'Untitled' }, { tenantId: 'tenant-1', userId: 'user-1' });
    const second = await scripts.create({ title: 'Untitled' }, { tenantId: 'tenant-1', userId: 'user-1' });
    assert.equal(first.slug, 'untitled');
    assert.equal(second.slug, 'untitled-1');

    const project = projectStore.create({ id: 'proj-odyssey', title: 'The Odyssey', project: { scriptText: 'INT. SHIP' } }, {
      tenantId: 'tenant-1',
      createdByUserId: 'user-1',
    });
    const linked = await scripts.ensureForProject(project, {
      tenantId: 'tenant-1',
      userId: 'user-1',
      author: 'Homer',
      projectStore,
    });
    assert.equal(linked.slug, 'the-odyssey');
    assert.equal(projectStore.read('proj-odyssey', { ownerId: 'tenant-1' }).scriptId, linked.id);

    const synced = await scripts.syncFromProject({
      ...projectStore.read('proj-odyssey', { ownerId: 'tenant-1' }),
      title: 'The Odyssey',
      scriptText: 'INT. SHIP - NIGHT',
    }, { tenantId: 'tenant-1' });
    assert.equal(synced.scriptText, 'INT. SHIP - NIGHT');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
