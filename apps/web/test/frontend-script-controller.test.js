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
