const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const controllerPromise = import(path.join(__dirname, '..', 'public', 'js', 'scripts', 'controller.js'));

test('script controller reports missing required controls as one clear DOM-contract error', async () => {
  const { initScriptController } = await controllerPromise;
  assert.throws(
    () => initScriptController({ pageTabButtons: [], pagePanels: [] }),
    /Script controller is missing required DOM bindings:.*scriptText.*pageTabButtons/,
  );
});
