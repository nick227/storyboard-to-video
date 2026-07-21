const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const textValuesPromise = import(path.join(__dirname, '..', 'public', 'modules', 'text-values.js'));
const sceneShotsPromise = import(path.join(__dirname, '..', 'public', 'modules', 'scene-shots.js'));

test('textValue never renders arbitrary objects as object Object', async () => {
  const { textValue } = await textValuesPromise;
  assert.equal(textValue({ unexpected: true }), '');
  assert.equal(textValue({ text: 'Recovered text' }), 'Recovered text');
  assert.equal(textValue({ prompt: { value: 'Recovered prompt' } }, ['prompt']), 'Recovered prompt');
  assert.equal(textValue({ narrationText: 'Recovered narration' }, ['narrationText']), 'Recovered narration');
});

test('scene prompt normalization unwraps text and rejects arbitrary objects', async () => {
  const { adaptSceneImageShot, setImagePrompt } = await sceneShotsPromise;
  const scene = adaptSceneImageShot({ prompt: { prompt: 'Wrapped prompt' } });
  assert.equal(scene.prompt, 'Wrapped prompt');

  setImagePrompt(scene, { unexpected: true });
  assert.equal(scene.prompt, '');
});
