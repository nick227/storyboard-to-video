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
  assert.equal(created.artifacts.screenplay.visibility, 'private');
  assert.equal(created.artifacts.storyboard.visibility, 'private');
  assert.equal(created.sharePath, '/anonymous/the-odyssey/screenplay');
  assert.equal(created.sharePaths.storyboard, '/anonymous/the-odyssey/storyboard');

  await assert.rejects(() => scripts.getPublicBySlug('the-odyssey'), (error) => error.code === 'SCRIPT_NOT_FOUND');

  const published = await scripts.setVisibility(created.id, 'public', { tenantId: 'tenant-1' });
  assert.equal(published.visibility, 'public');
  assert.ok(published.publishedAt);
  assert.equal(published.artifacts.screenplay.visibility, 'public');
  assert.equal(published.artifacts.storyboard.visibility, 'private');

  const publicScript = await scripts.getPublicBySlug('the-odyssey');
  assert.equal(publicScript.scriptText, 'FADE IN:\n\nA wine-dark sea.');
  assert.equal(publicScript.author, 'Homer');
  assert.equal(publicScript.likeCount, 0);
  assert.equal(publicScript.likedByMe, false);
  assert.deepEqual(publicScript.moreByAuthor, []);

  const liked = await scripts.toggleLike(created.id, { userId: 'reader-1' });
  assert.equal(liked.liked, true);
  assert.equal(liked.likeCount, 1);
  const likedView = await scripts.getPublicBySlug('the-odyssey', { userId: 'reader-1' });
  assert.equal(likedView.likedByMe, true);
  assert.equal(likedView.likeCount, 1);
  const unliked = await scripts.toggleLike(created.id, { userId: 'reader-1' });
  assert.equal(unliked.liked, false);
  assert.equal(unliked.likeCount, 0);

  const listed = await scripts.listPublic();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].slug, 'the-odyssey');
  assert.equal(listed[0].scriptText, undefined);

  await scripts.setVisibility(created.id, 'private', { tenantId: 'tenant-1' });
  await assert.rejects(() => scripts.getPublicBySlug('the-odyssey'), (error) => error.code === 'SCRIPT_NOT_FOUND');
});

test('script update keeps slug synced to title until the slug is manually customized', async () => {
  const store = new ScriptStore();
  const scripts = createScriptsService({ store });
  const created = await scripts.create({ title: 'Untitled' }, { tenantId: 'tenant-1', userId: 'user-1' });
  assert.equal(created.slug, 'untitled');

  // Autosave can commit a partial title mid-keystroke (e.g. the "R" of "Ricky Tomlin").
  // The slug must not lock onto that fragment -- it should keep tracking the title.
  const partial = await scripts.update(created.id, { title: 'R' }, { tenantId: 'tenant-1' });
  assert.equal(partial.slug, 'r');

  const renamed = await scripts.update(created.id, { title: 'Ricky Tomlin' }, { tenantId: 'tenant-1' });
  assert.equal(renamed.slug, 'ricky-tomlin');
  assert.equal(renamed.title, 'Ricky Tomlin');

  const renamedAgain = await scripts.update(created.id, { title: 'Final Cut' }, { tenantId: 'tenant-1' });
  assert.equal(renamedAgain.slug, 'final-cut');
  assert.equal(renamedAgain.title, 'Final Cut');

  // Once the slug is set explicitly, it stops tracking the title.
  const customized = await scripts.update(created.id, { slug: 'custom-slug' }, { tenantId: 'tenant-1' });
  assert.equal(customized.slug, 'custom-slug');

  const renamedAfterCustomization = await scripts.update(created.id, { title: 'Yet Another Title' }, { tenantId: 'tenant-1' });
  assert.equal(renamedAfterCustomization.slug, 'custom-slug');
});

test('public reader lists more scripts by createdByUserId not author string', async () => {
  const store = new ScriptStore();
  const scripts = createScriptsService({ store });
  const first = await scripts.create({ title: 'Alpha', author: 'Pen Name', scriptText: 'A' }, { tenantId: 't1', userId: 'author-1' });
  const second = await scripts.create({ title: 'Beta', author: 'Other Label', scriptText: 'B' }, { tenantId: 't1', userId: 'author-1' });
  const other = await scripts.create({ title: 'Gamma', author: 'Pen Name', scriptText: 'C' }, { tenantId: 't1', userId: 'author-2' });
  await scripts.setVisibility(first.id, 'public', { tenantId: 't1' });
  await scripts.setVisibility(second.id, 'public', { tenantId: 't1' });
  await scripts.setVisibility(other.id, 'public', { tenantId: 't1' });

  const page = await scripts.getPublicBySlug('alpha');
  assert.equal(page.moreByAuthor.length, 1);
  assert.equal(page.moreByAuthor[0].slug, 'beta');
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

    const projectWithoutScriptText = { ...projectStore.read('proj-odyssey', { ownerId: 'tenant-1' }), title: 'The Odyssey' };
    delete projectWithoutScriptText.scriptText;
    const preserved = await scripts.ensureForProject(projectWithoutScriptText, {
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectStore,
    });
    assert.equal(preserved.scriptText, 'INT. SHIP - NIGHT');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('public summary includes logline, category filter, and view recording', async () => {
  const store = new ScriptStore();
  const scripts = createScriptsService({ store });
  const categories = await scripts.listCategories();
  assert.ok(categories.some((c) => c.slug === 'feature'));
  const feature = categories.find((c) => c.slug === 'feature');

  const created = await scripts.create({
    title: 'Harbor Night',
    logline: 'A dockworker finds a letter that should not exist.',
    summary: 'A longer story summary that can drive the AI assistant from scratch.',
    categoryId: feature.id,
    tagSlugs: ['noir', 'mystery'],
    scriptText: 'FADE IN:',
  }, { tenantId: 't1', userId: 'author-1' });
  assert.equal(created.logline, 'A dockworker finds a letter that should not exist.');
  assert.equal(created.summary, 'A longer story summary that can drive the AI assistant from scratch.');
  assert.equal(created.category.slug, 'feature');
  assert.equal(created.tags.length, 2);

  await scripts.setVisibility(created.id, 'public', { tenantId: 't1' });
  const listed = await scripts.listPublicByCategory('feature');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].logline, 'A dockworker finds a letter that should not exist.');
  assert.equal(listed[0].summary, 'A longer story summary that can drive the AI assistant from scratch.');
  assert.equal(listed[0].viewCount, 0);
  assert.ok(listed[0].tags.some((t) => t.slug === 'noir'));

  const byTag = await scripts.listPublicByTag('noir');
  assert.equal(byTag.length, 1);

  const page = await scripts.getPublicBySlug('harbor-night');
  assert.equal(page.viewCount, 1);
  assert.equal(page.summary, 'A longer story summary that can drive the AI assistant from scratch.');
  assert.equal(page.breadcrumb.category.slug, 'feature');
  const again = await scripts.getPublicBySlug('harbor-night');
  assert.equal(again.viewCount, 2);

  const stats = await scripts.getOwnerStats(created.id, { tenantId: 't1' });
  assert.equal(stats.viewCount, 2);
  assert.equal(stats.likeCount, 0);
});

test('script summary can be updated and is capped at 4000 characters', async () => {
  const store = new ScriptStore();
  const scripts = createScriptsService({ store });
  const created = await scripts.create({
    title: 'Summary Cap',
    scriptText: '',
  }, { tenantId: 't1', userId: 'u1' });
  const updated = await scripts.update(created.id, {
    summary: `${'x'.repeat(4000)}EXTRA`,
  }, { tenantId: 't1' });
  assert.equal(updated.summary.length, 4000);
  assert.equal(updated.summary, 'x'.repeat(4000));
});

test('storyboard and timeline publish independently of screenplay', async () => {
  const store = new ScriptStore();
  const scripts = createScriptsService({ store });
  const created = await scripts.create({
    title: 'Split Publish',
    scriptText: 'FADE IN:',
  }, { tenantId: 't1', userId: 'u1' });

  const board = await scripts.setVisibility(created.id, 'public', {
    tenantId: 't1',
    artifact: 'storyboard',
  });
  assert.equal(board.visibility, 'private');
  assert.equal(board.artifacts.storyboard.visibility, 'public');
  assert.ok(board.artifacts.storyboard.publishedAt);
  assert.equal(board.sharePaths.storyboard, '/anonymous/split-publish/storyboard');

  await assert.rejects(() => scripts.getPublicBySlug('split-publish'), (error) => error.code === 'SCRIPT_NOT_FOUND');
  const publicBoard = await scripts.getPublicBySlug('split-publish', { artifact: 'storyboard' });
  assert.equal(publicBoard.artifact, 'storyboard');
  assert.equal(publicBoard.scriptText, undefined);
  assert.equal(publicBoard.sharePath, '/anonymous/split-publish/storyboard');
  assert.equal(publicBoard.project, null);

  const listedBoards = await scripts.listPublic({ artifact: 'storyboard' });
  assert.equal(listedBoards.length, 1);
  assert.equal(listedBoards[0].artifact, 'storyboard');
  assert.equal((await scripts.listPublic({ artifact: 'screenplay' })).length, 0);

  await scripts.setVisibility(created.id, 'public', { tenantId: 't1', artifact: 'timeline' });
  assert.equal((await scripts.listPublic({ artifact: 'timeline' })).length, 1);
  assert.equal((await scripts.listPublic({ artifact: 'storyboard' })).length, 1);

  const allListed = await scripts.listPublic({ artifact: 'all' });
  assert.equal(allListed.length, 2);
  assert.ok(allListed.every((item) => item.artifact === 'storyboard' || item.artifact === 'timeline'));
  assert.ok(String(allListed[0].publishedAt || '') >= String(allListed[1].publishedAt || ''));
});

test('script cover art upload replace and public stream', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'script-cover-'));
  try {
    const { createLocalBlobStore } = require('../src/storage/blob-store');
    const blobStore = createLocalBlobStore({ root });
    const store = new ScriptStore();
    const scripts = createScriptsService({ store, blobStore });
    const created = await scripts.create({
      title: 'Covered',
      scriptText: 'FADE IN:',
    }, { tenantId: 't1', userId: 'u1' });
    assert.equal(created.coverUrl, null);
    assert.equal(created.hasCover, false);

    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    const uploaded = await scripts.uploadCover(created.id, {
      buffer: png,
      mimetype: 'image/png',
    }, { tenantId: 't1' });
    assert.equal(uploaded.hasCover, true);
    assert.match(uploaded.coverUrl, new RegExp(`/api/scripts/${created.id}/cover\\?v=`));

    await scripts.setVisibility(created.id, 'public', { tenantId: 't1' });
    const listed = await scripts.listPublic();
    assert.match(listed[0].coverUrl, /\/api\/public\/scripts\/covered\/cover\?v=/);

    const stream = await scripts.publicCoverStream('covered');
    assert.equal(stream.mimeType, 'image/png');
    const chunks = [];
    for await (const chunk of stream.stream) chunks.push(chunk);
    assert.ok(Buffer.concat(chunks).length >= 8);

    const removed = await scripts.removeCover(created.id, { tenantId: 't1' });
    assert.equal(removed.hasCover, false);
    assert.equal(removed.coverUrl, null);
    await assert.rejects(() => scripts.publicCoverStream('covered'), (error) => error.code === 'COVER_NOT_FOUND');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('public storyboard view returns sanitized project scenes without a cover payload', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-public-view-'));
  const store = new ScriptStore();
  const projectStore = new ProjectStore(root);
  const scripts = createScriptsService({ store, projectStore });
  const created = await scripts.create({
    title: 'Board View',
    scriptText: 'FADE IN:',
  }, { tenantId: 't1', userId: 'u1' });
  await scripts.setVisibility(created.id, 'public', { tenantId: 't1', artifact: 'storyboard' });

  const project = projectStore.create({
    id: 'board-1',
    title: 'Board View',
    scriptId: created.id,
    project: {
      scenes: [{
        id: 's1',
        title: 'Open',
        narrationText: 'She opens the door.',
        versions: [{ path: '/projects/board-1/assets/images/a.png' }],
        activeVersionIndex: 0,
      }],
    },
  }, { ownerId: 't1', createdByUserId: 'u1' });

  const publicBoard = await scripts.getPublicBySlug('board-view', { artifact: 'storyboard' });
  assert.equal(publicBoard.project.id, project.id);
  assert.equal(publicBoard.project.scenes.length, 1);
  assert.equal(publicBoard.project.scenes[0].imagePath, '/projects/board-1/assets/images/a.png');
  assert.equal(publicBoard.project.scenes[0].narrationText, 'She opens the door.');
  assert.equal(publicBoard.project.scenes[0].versions, undefined);
  assert.equal(publicBoard.project.scenes[0].words, undefined);
  assert.equal(await scripts.canPublicReadProjectMedia('board-1'), true);
  assert.equal(await scripts.canPublicReadProjectMedia('missing'), false);

  fs.rmSync(root, { recursive: true, force: true });
});
