const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function controllerModule() {
  return import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'studio', 'custom-styles-controller.js')).href);
}

test('custom style save mode creates when no persisted style id exists', async () => {
  const { isPersistedCustomStyle } = await controllerModule();
  const styles = [{ id: 'style-1', name: 'Existing' }];
  assert.equal(isPersistedCustomStyle(styles, null), false);
  assert.equal(isPersistedCustomStyle(styles, 'new'), false);
  assert.equal(isPersistedCustomStyle(styles, 'null'), false);
  assert.equal(isPersistedCustomStyle(styles, 'missing'), false);
  assert.equal(isPersistedCustomStyle(styles, 'style-1'), true);
});

test('custom styles controller disables the real close button binding', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'studio', 'custom-styles-controller.js'), 'utf8');
  assert.match(source, /elements\.customStylesCloseBtn\.disabled/);
  assert.doesNotMatch(source, /elements\.customStyleCloseBtn\b/);
  assert.match(source, /setEditorDisabled\(true\)/);
  assert.match(source, /finally \{\s*state\.loading = false;\s*setEditorDisabled\(false\);/s);
});
