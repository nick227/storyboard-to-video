const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const controllerPromise = import(path.join(__dirname, '..', 'public', 'js', 'scripts', 'controller.js'));
const webRoot = path.join(__dirname, '..');

test('script controller reports missing required controls as one clear DOM-contract error', async () => {
  const { initScriptController } = await controllerPromise;
  assert.throws(
    () => initScriptController({ pageTabButtons: [], pagePanels: [] }),
    /Script controller is missing required DOM bindings:.*scriptText.*pageTabButtons/,
  );
});

test('fullscreen screenplay hides work chrome and leaves scrolling to the workspace', () => {
  const css = fs.readFileSync(path.join(webRoot, 'stylesheets', '02-script.css'), 'utf8');
  const controller = fs.readFileSync(path.join(webRoot, 'public', 'js', 'scripts', 'controller.js'), 'utf8');

  assert.match(css, /body\.script-focus-active \.sf-workbar,[\s\S]*?visibility:\s*hidden/);
  assert.match(css, /#scriptPagePanel\.is-script-focus\s*\{[\s\S]*?z-index:\s*99/);
  assert.match(css, /#scriptPagePanel\.is-script-focus \.story-concept\s*\{[\s\S]*?overflow:\s*hidden/);
  assert.match(css, /#scriptPagePanel\.is-script-focus \.screenplay-workspace\s*\{[\s\S]*?overflow:\s*auto/);
  assert.match(controller, /document\.querySelector\('\.sf-workbar'\)/);
});

test('mobile screenplay chrome uses an accessible tab row and non-overlapping control rail', () => {
  const css = fs.readFileSync(path.join(webRoot, 'stylesheets', '02-script.css'), 'utf8');
  const topbarCss = fs.readFileSync(path.join(webRoot, 'stylesheets', 'shared', 'topbar.css'), 'utf8');
  const editorCss = fs.readFileSync(path.join(webRoot, 'stylesheets', 'components', 'screenplay-editor.css'), 'utf8');

  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.script-header-row\s*\{[\s\S]*?display:\s*flex;[\s\S]*?overflow-x:\s*auto/);
  assert.match(css, /\.script-download-menu\s*\{[^}]*position:\s*fixed/);
  assert.match(topbarCss, /\.studio-shell \.sf-studio-global\s*\{[^}]*flex:\s*1 1 0;[^}]*width:\s*0/);
  assert.match(topbarCss, /\.studio-shell \.sf-artifact-tabs\s*\{[^}]*position:\s*absolute;[^}]*width:\s*100%/);
  assert.match(topbarCss, /\.studio-shell \.sf-artifact-tab\s*\{[^}]*flex:\s*1 1 0;[^}]*justify-content:\s*center/);
  assert.match(editorCss, /\.script-page\.screenplay-title-page::after\s*\{\s*content:\s*none/);
});
