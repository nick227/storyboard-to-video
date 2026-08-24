const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

function normalize(text = '') {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .join('\n')
    .trim();
}

async function loadAdapters() {
  const rawAdapterPath = pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'screenplay-editor', 'js', 'adapters', 'RawScriptAdapter.js')).href;
  const fountainAdapterPath = pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'screenplay-editor', 'js', 'adapters', 'FountainAdapter.js')).href;

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
  const pageManagerPath = pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'screenplay-editor', 'js', 'page', 'PageManager.js')).href;
  const { PageManager } = await import(pageManagerPath);

  const pm = new PageManager({});
  assert.equal(typeof pm.getPages, 'function');
  assert.equal(typeof pm.getPageCount, 'function');
  assert.equal(typeof pm.getCurrentPageNumber, 'function');
  assert.equal(pm.getCurrentPageNumber(), 1);
});

test('PageManager starts an empty screenplay with a Scene Heading line', async () => {
  const pageManagerPath = pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'screenplay-editor', 'js', 'page', 'PageManager.js')).href;
  const { PageManager } = await import(pageManagerPath);
  const container = {
    innerHTML: '',
    children: [],
    appendChild(child) { this.children.push(child); },
  };
  const manager = new PageManager({ container });
  manager.pageFactory = {
    createPage: () => ({ children: [], appendChild(child) { this.children.push(child); } }),
    createLine: (format, content) => ({ format, content }),
  };

  manager.renderDocument([]);

  assert.equal(container.children[0].children[0].format, 'header');
});

test('ScreenplayEditor focuses and formats the first line only when the page is blank', async () => {
  const editorPath = pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'screenplay-editor', 'js', 'ScreenplayEditor.js')).href;
  const { ScreenplayEditor } = await import(editorPath);
  const firstLine = {
    textContent: '',
    format: 'action',
    setAttribute(name, value) { if (name === 'data-format') this.format = value; },
  };
  const editor = Object.create(ScreenplayEditor.prototype);
  editor.workspace = { querySelectorAll: () => [firstLine] };
  editor.domHandler = { focusLine: (...args) => { editor.focusArgs = args; } };
  editor._updateSelectionState = () => {};

  assert.equal(editor.focusInitialSceneHeading({ preventScroll: true }), true);
  assert.equal(firstLine.format, 'header');
  assert.deepEqual(editor.focusArgs, [firstLine, 0, { preventScroll: true }]);

  firstLine.textContent = 'INT. OFFICE - DAY';
  editor.focusArgs = null;
  assert.equal(editor.focusInitialSceneHeading(), false);
  assert.equal(editor.focusArgs, null);
});

test('editor title page is page 0 and remains outside screenplay pagination', () => {
  const editorSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'screenplay-editor', 'js', 'ScreenplayEditor.js'), 'utf8');
  const editorCss = fs.readFileSync(path.join(__dirname, '..', 'stylesheets', 'components', 'screenplay-editor.css'), 'utf8');

  assert.match(editorSource, /page\.dataset\.pageNumber = '0'/);
  assert.match(editorSource, /this\.scaleTarget\.append\(this\.titlePage, this\.scriptPages\)/);
  assert.match(editorSource, /container: this\.scriptPages/);
  assert.match(editorSource, /page\.className = 'script-page screenplay-title-page'/);
  assert.match(editorCss, /\.script-page\s*\{[\s\S]*?width: var\(--page-width\);[\s\S]*?height: var\(--page-height\)/);
  assert.match(editorCss, /\.screenplay-title-page-title\s*\{[^}]*font:\s*700 38pt/);
  assert.doesNotMatch(editorSource, /_createTitlePageSection/);
  assert.doesNotMatch(editorSource, /screenplay-title-page-summary/);
  assert.match(editorSource, /optional\.append\(logline, cover\)/);
  assert.match(editorSource, /screenplay-title-page-cover/);
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
