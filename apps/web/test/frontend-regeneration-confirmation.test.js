const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const webRoot = path.join(__dirname, '..');
const renderingPromise = import(path.join(webRoot, 'public', 'js', 'studio', 'rendering.js'));

test('regeneration confirmation uses the entity-specific provider selection', async () => {
  const { regenerationProviderSelection } = await renderingPromise;
  const select = (value, label) => ({ value, selectedOptions: [{ textContent: label }] });
  const els = {
    textProvider: select('openai', 'OpenAI'),
    imageProvider: select('gemini', 'Gemini'),
    videoProvider: select('minimax', 'MiniMax'),
  };

  assert.deepEqual(regenerationProviderSelection('image', els), { kind: 'Image provider', label: 'Gemini' });
  assert.deepEqual(regenerationProviderSelection('prompt', els), { kind: 'LLM provider', label: 'OpenAI' });
  assert.deepEqual(regenerationProviderSelection('video', els), { kind: 'Video provider', label: 'MiniMax' });
});

test('hidden regeneration summaries cannot leak the previous video provider', () => {
  const css = fs.readFileSync(path.join(webRoot, 'public', 'css', 'styles.css'), 'utf8');
  assert.match(css, /\.confirm-video-summary\[hidden\][\s\S]*?display:\s*none/);
});

test('planning confirmation names the normalized LLM provider', async () => {
  const { buildGenerationPreflight } = await import(path.join(webRoot, 'public', 'js', 'studio', 'run-controller.js'));
  const confirmation = buildGenerationPreflight('planningReplan', {
    scenes: [{ id: 'shot-1' }],
    labels: { textProvider: 'OpenAI' },
  });
  assert.equal(confirmation.bullets[0], 'LLM provider · OpenAI');
});

test('run controller wires the subtitles selection alongside every other stage', async () => {
  const { initRunController } = await import(path.join(webRoot, 'public', 'js', 'studio', 'run-controller.js'));
  const element = (extra = {}) => ({
    listeners: {},
    addEventListener(type, handler) { this.listeners[type] = handler; },
    close() {},
    showModal() {},
    selectedOptions: [{ textContent: 'Test' }],
    value: '',
    dataset: {},
    ...extra,
  });
  const names = [
    'textProvider', 'imageProvider', 'audioProvider', 'videoMotionIntensity',
    'subtitleStyle', 'confirmModal', 'confirmTitle', 'confirmIntro',
    'confirmBullets', 'confirmCloseBtn', 'confirmCancelBtn', 'confirmRunBtn',
    'startModal', 'sceneLabel', 'sceneTotal', 'rangeAll', 'rangeNext',
    'nextCount', 'regenerateIfExists', 'startCloseBtn', 'startCancelBtn', 'startConfirmBtn',
    'planningCheck', 'planningStatus', 'imagesCheck', 'imagesStatus',
    'audioCheck', 'audioStatus', 'videoCheck', 'videoStatus',
    'subtitlesCheck', 'subtitlesStatus', 'replanBtn', 'regenerateImagesBtn',
    'regenerateAudioBtn', 'regenerateVideoBtn', 'regenerateSubtitlesBtn',
    'startPauseBtn',
  ];
  const elements = Object.fromEntries(names.map((name) => [name, element()]));
  for (const stage of ['planning', 'images', 'audio', 'video', 'subtitles']) {
    elements[`${stage}Check`].dataset.stage = stage;
  }

  const noop = () => {};
  initRunController(elements, {
    setStatus: noop,
    replan: async () => {},
    regenerate: async () => {},
    runFlow: async () => ({ stoppedAt: null }),
    renderStatus: noop,
    renderStoryboard: noop,
  });

  assert.equal(typeof elements.subtitlesCheck.listeners.change, 'function');
});
