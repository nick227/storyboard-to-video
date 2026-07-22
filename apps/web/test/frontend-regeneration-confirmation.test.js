const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const webRoot = path.join(__dirname, '..');
const renderingPromise = import(path.join(webRoot, 'public', 'modules', 'rendering.js'));

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
  const css = fs.readFileSync(path.join(webRoot, 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.confirm-video-summary\[hidden\][\s\S]*?display:\s*none/);
});

test('planning confirmation names the selected LLM provider', () => {
  const app = fs.readFileSync(path.join(webRoot, 'public', 'app.js'), 'utf8');
  assert.match(app, /LLM provider[^\n]+selectedLabel\(els\.textProvider\)/);
});
