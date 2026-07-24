const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const webRoot = path.join(__dirname, '..');
const persistencePromise = import(pathToFileURL(path.join(webRoot, 'public/js/core/persistence.js')).href);
const storePromise = import(pathToFileURL(path.join(webRoot, 'public/js/core/store.js')).href);
const pathsPromise = import(pathToFileURL(path.join(webRoot, 'public/js/core/app-paths.js')).href);

test('Library route project id wins over a stale or ambiguous slug', async () => {
  const [{ findStoryboardForRoute }, { projectStore }] = await Promise.all([persistencePromise, storePromise]);
  const odyssey = { id: 'project-odyssey', title: 'The Odyssey', script: { slug: 'the-odyssey' } };
  const previous = { id: 'project-previous', title: 'Previous Story', script: { slug: 'previous-story' } };
  projectStore.set({ currentId: previous.id, storyboards: [previous, odyssey] });

  assert.equal(findStoryboardForRoute({
    projectId: odyssey.id,
    workSlug: 'untitled',
  }), odyssey);
});

test('server script identity replaces stale cached slug during library restore merge', async () => {
  const { mergeStoryboardLibraryProjects } = await persistencePromise;
  const [merged] = mergeStoryboardLibraryProjects(
    [{ id: 'project-odyssey', title: 'The Odyssey', scriptId: 'script-1', script: { slug: 'untitled' }, revision: 2 }],
    [{ id: 'project-odyssey', title: 'The Odyssey', scriptId: 'script-1', script: { slug: 'the-odyssey' }, revision: 3 }],
  );

  assert.equal(merged.script.slug, 'the-odyssey');
  assert.equal(merged.revision, 3);
});

test('Library Edit links include the exact project target', () => {
  const source = fs.readFileSync(path.join(webRoot, 'public/js/pages/scripts-index.js'), 'utf8');
  assert.match(source, /searchParams\.set\('project', project\.id\)/);
});

test('renamed works do not keep an untitled editor slug', async () => {
  const { scriptSlugFromRecord } = await pathsPromise;
  assert.equal(scriptSlugFromRecord({
    title: 'Adventures of VR',
    script: { slug: 'untitled' },
  }), 'adventures-of-vr');
});

test('startup renders the selected work before optional catalogs finish', () => {
  const source = fs.readFileSync(path.join(webRoot, 'public/js/app.js'), 'utf8');
  const syncIndex = source.indexOf('scriptController?.syncFromText()');
  const enrichmentIndex = source.indexOf('Promise.all([', syncIndex);
  assert.ok(syncIndex >= 0 && enrichmentIndex > syncIndex);
  assert.ok(!source.slice(syncIndex, enrichmentIndex + 12).includes('await Promise.all'));
});

test('tab initialization cannot rewrite an unresolved work URL to untitled', () => {
  const source = fs.readFileSync(path.join(webRoot, 'public/js/scripts/controller.js'), 'utf8');
  assert.ok(source.includes('if (persist && getCurrentRecord?.())'));
});
