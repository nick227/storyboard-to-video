const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const workflowsPromise = import(path.join(__dirname, '..', 'public', 'js', 'generation', 'workflows.js'));

function existingScene(id, number, title = `Scene ${number}`) {
  return {
    id,
    sceneNumber: number,
    title,
    sourceScriptFragment: `Source ${number}`,
    narrationText: `Narration ${number}`,
    beat: `Beat ${number}`,
    prompt: `Prompt ${number}`,
    shots: [{ prompt: `Prompt ${number}`, versions: [], videoVersions: [] }],
    audioVersions: [],
    subtitleVersions: [],
  };
}

test('insertBlankSceneAt creates a source-optional canonical scene and renumbers default titles', async () => {
  const { insertBlankSceneAt } = await workflowsPromise;
  const result = insertBlankSceneAt([
    existingScene('one', 1),
    existingScene('two', 2, 'Custom chapter'),
  ], 1, 'blank');

  assert.deepEqual(result.scenes.map((scene) => scene.id), ['one', 'blank', 'two']);
  assert.deepEqual(result.scenes.map((scene) => scene.sceneNumber), [1, 2, 3]);
  assert.equal(result.scenes[0].title, 'Scene 1');
  assert.equal(result.insertedScene.title, 'Scene 2');
  assert.equal(result.scenes[2].title, 'Custom chapter');
  assert.equal(result.insertedScene.sourceScriptFragment, '');
  assert.equal(result.insertedScene.narrationText, '');
  assert.equal(result.insertedScene.prompt, '');
  assert.equal(result.insertedScene.sourceMappingMethod, 'manual');
  assert.equal(result.scenes[0].structuralContextStale, true);
  assert.equal(result.scenes[2].structuralContextStale, true);
});

test('regenerateImage blocks an explicit blank scene and skips it during a batch', async () => {
  const { regenerateImage } = await workflowsPromise;
  const blank = { id: 'blank', title: 'Scene 1', prompt: '', shots: [{ prompt: '', versions: [] }] };
  const statuses = [];

  await assert.rejects(
    regenerateImage(0, blank, {}, (message) => statuses.push(message)),
    /no visual prompt/i,
  );
  assert.equal(await regenerateImage(0, blank, {}, (message) => statuses.push(message), true), true);
  assert.match(statuses.at(-1), /Skipped scene 1: no prompt/);
});
