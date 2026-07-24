const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const webRoot = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(webRoot, 'public', 'js', 'app.js'), 'utf8');
const studioTemplate = fs.readFileSync(path.join(webRoot, 'pages', 'studio.html'), 'utf8');

test('studio shell binds the required status panel from its template', () => {
  assert.match(studioTemplate, /id="statusPanel"/);
  assert.match(appSource, /statusPanel:\s*document\.getElementById\('statusPanel'\)/);
});
