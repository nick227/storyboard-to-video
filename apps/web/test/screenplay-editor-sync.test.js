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

test('Standard Fountain text is not unnecessarily rewritten with @ or . markers', async () => {
  const { RawScriptAdapter } = await loadAdapters();

  const standardScript = `INT. COFFEE SHOP - DAY\n\nMARCUS\n(smiling)\nStill using that ancient machine?`;
  const doc = RawScriptAdapter.parse(standardScript, 'fountain');
  const serialized = RawScriptAdapter.serialize(doc, 'fountain');

  assert.equal(serialized.includes('.INT.'), false);
  assert.equal(serialized.includes('@MARCUS'), false);
  assert.equal(normalize(serialized), normalize(standardScript));
});

test('Fountain serialization handles empty scripts gracefully', async () => {
  const { RawScriptAdapter } = await loadAdapters();

  const document = RawScriptAdapter.parse('', 'fountain');
  const roundTripped = RawScriptAdapter.serialize(document, 'fountain');

  assert.equal(roundTripped, '');
});

test('Fountain parsing classifies headers, speakers, dialogue, directions, action, and transitions', async () => {
  const { FountainAdapter } = await loadAdapters();

  const script = `EXT. PARK - NIGHT\n\nJOHN\n(whispering)\nDid you hear that?\n\nA shadow moves in the trees.\n\nCUT TO:`;
  const doc = FountainAdapter.toDocument(script);

  assert.equal(doc.lines.length, 6);
  assert.equal(doc.lines[0].format, 'header');
  assert.equal(doc.lines[1].format, 'speaker');
  assert.equal(doc.lines[2].format, 'directions');
  assert.equal(doc.lines[3].format, 'dialog');
  assert.equal(doc.lines[4].format, 'action');
  assert.equal(doc.lines[5].format, 'transition');
});

test('PageManager exposes page count, page elements, and page query API', async () => {
  const pageManagerPath = pathToFileURL(path.join(__dirname, '..', 'public', 'modules', 'screenplay-editor', 'js', 'page', 'PageManager.js')).href;
  const { PageManager } = await import(pageManagerPath);

  const pm = new PageManager({});
  assert.equal(typeof pm.getPages, 'function');
  assert.equal(typeof pm.getPageCount, 'function');
  assert.equal(typeof pm.getCurrentPageNumber, 'function');
  assert.equal(pm.getCurrentPageNumber(), 1);
});

test('FountainAdapter losslessly preserves custom mixed-case speakers and custom headers', async () => {
  const { RawScriptAdapter, FountainAdapter } = await loadAdapters();

  const lines = [
    { format: 'header', content: 'COFFEE SHOP' },
    { format: 'speaker', content: 'marcus' },
    { format: 'directions', content: 'smiling' },
    { format: 'dialog', content: 'Still using that ancient machine?' }
  ];

  const doc = RawScriptAdapter.fromArray(lines);
  const serializedFountain = FountainAdapter.toFountain(doc);

  assert.match(serializedFountain, /\.COFFEE SHOP/);
  assert.match(serializedFountain, /@marcus/);
  assert.match(serializedFountain, /\(smiling\)/);

  const reloadedDoc = FountainAdapter.toDocument(serializedFountain);

  assert.equal(reloadedDoc.lines[0].format, 'header');
  assert.equal(reloadedDoc.lines[0].content, 'COFFEE SHOP');
  assert.equal(reloadedDoc.lines[1].format, 'speaker');
  assert.equal(reloadedDoc.lines[1].content, 'marcus');
  assert.equal(reloadedDoc.lines[2].format, 'directions');
  assert.equal(reloadedDoc.lines[2].content, 'smiling');
  assert.equal(reloadedDoc.lines[3].format, 'dialog');
  assert.equal(reloadedDoc.lines[3].content, 'Still using that ancient machine?');
});
