const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_PROJECT_SCENES,
  projectDocument,
  imageGeneration,
  audioGeneration,
  videoGeneration,
  subtitleGeneration,
  createScript,
  scriptVisibility,
} = require('../src/schemas');

test('project persistence and media requests share the 200-scene planning limit', () => {
  const scenes = Array.from({ length: 57 }, (_, index) => ({ id: `scene-${index + 1}` }));
  assert.equal(MAX_PROJECT_SCENES, 200);
  assert.equal(projectDocument.parse({ scenes }).scenes.length, 57);

  const common = { projectId: 'project-1', sceneId: 'scene-57', sceneNumber: 57 };
  assert.equal(imageGeneration.parse({ ...common, scenePrompt: 'Prompt.' }).sceneNumber, 57);
  assert.equal(audioGeneration.parse({ ...common, narrationText: 'Narration.' }).sceneNumber, 57);
  assert.equal(videoGeneration.parse(common).sceneNumber, 57);
  assert.equal(subtitleGeneration.parse(common).sceneNumber, 57);
});

test('project persistence still rejects storyboards beyond the platform limit', () => {
  const scenes = Array.from({ length: MAX_PROJECT_SCENES + 1 }, (_, index) => ({ id: `scene-${index + 1}` }));
  assert.equal(projectDocument.safeParse({ scenes }).success, false);
});

test('script schemas accept create and visibility payloads', () => {
  assert.equal(createScript.parse({ title: 'The Odyssey' }).title, 'The Odyssey');
  assert.equal(scriptVisibility.parse({ visibility: 'public' }).visibility, 'public');
  assert.equal(scriptVisibility.safeParse({ visibility: 'shared' }).success, false);
});
