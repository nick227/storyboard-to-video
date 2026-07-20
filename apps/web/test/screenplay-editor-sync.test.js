const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function normalize(text = '') {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .join('\n')
    .trim();
}

async function loadAdapters() {
  const rawAdapterPath = pathToFileURL(path.join(__dirname, '..', 'public', 'modules', 'screenplay-editor', 'js', 'adapters', 'RawScriptAdapter.js')).href;
  const fountainAdapterPath = pathToFileURL(path.join(__dirname, '..', 'public', 'modules', 'screenplay-editor', 'js', 'adapters', 'FountainAdapter.js')).href;

  const { RawScriptAdapter } = await import(rawAdapterPath);
  const { FountainAdapter } = await import(fountainAdapterPath);

  return { RawScriptAdapter, FountainAdapter };
}

test('Fountain round-trip serialization preserves structured screenplay lines', async () => {
  const { RawScriptAdapter } = await loadAdapters();

  const originalScript = `INT. COFFEE SHOP - DAY

MARCUS
(smiling)
Still using that ancient machine?

SARAH
It has soul. No notifications.

SARAH walks over to the counter.`;

  const document = RawScriptAdapter.parse(originalScript, 'fountain');
  const roundTripped = RawScriptAdapter.serialize(document, 'fountain');

  assert.equal(normalize(roundTripped), normalize(originalScript));
});

test('Fountain serialization handles empty scripts gracefully', async () => {
  const { RawScriptAdapter } = await loadAdapters();

  const document = RawScriptAdapter.parse('', 'fountain');
  const roundTripped = RawScriptAdapter.serialize(document, 'fountain');

  assert.equal(roundTripped, '');
});

test('Fountain parsing classifies headers, speakers, dialogue, directions, and action', async () => {
  const { FountainAdapter } = await loadAdapters();

  const script = `EXT. PARK - NIGHT\n\nJOHN\n(whispering)\nDid you hear that?\n\nA shadow moves in the trees.`;
  const doc = FountainAdapter.toDocument(script);

  assert.equal(doc.lines.length, 5);
  assert.equal(doc.lines[0].format, 'header');
  assert.equal(doc.lines[1].format, 'speaker');
  assert.equal(doc.lines[2].format, 'directions');
  assert.equal(doc.lines[3].format, 'dialog');
  assert.equal(doc.lines[4].format, 'action');
});
