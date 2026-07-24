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

test('studio shell provides the media settings helper bindings', () => {
  for (const id of ['aspectRatioHelper', 'videoProviderHelper', 'videoDurationHelper', 'audioProviderHelper']) {
    assert.match(studioTemplate, new RegExp(`id="${id}"`));
    assert.match(appSource, new RegExp(`${id}:\\s*document\\.getElementById\\('${id}'\\)`));
  }
});

test('scene cards expose one unified entity controller instead of legacy entity icons', () => {
  const template = studioTemplate.match(/<template id="sceneCardTemplate">([\s\S]*?)<\/template>/)?.[1] || '';
  assert.equal((template.match(/class="scene-manage-btn"/g) || []).length, 1);
  assert.doesNotMatch(template, /scene-status-icon/);
  assert.doesNotMatch(template, /scene-delete-btn/);

  for (const id of [
    'entityModalSummary',
    'entityModalPreviousBtn',
    'entityModalNextBtn',
    'entityModalSourceText',
    'entityControllerRows',
    'entityModalDeleteBtn',
  ]) {
    assert.match(studioTemplate, new RegExp(`id="${id}"`));
    assert.match(appSource, new RegExp(`${id}:\\s*document\\.getElementById\\('${id}'\\)`));
  }
});

test('storyboard omits the project-level narration history section', () => {
  assert.doesNotMatch(studioTemplate, /id="narrationHistoryToggle"/);
  assert.doesNotMatch(studioTemplate, /id="narrationHistoryPanel"/);
  assert.doesNotMatch(studioTemplate, /id="narrationHistoryList"/);
  assert.doesNotMatch(appSource, /narrationHistoryToggle|narrationHistoryPanel|narrationHistoryList/);
});

test('both style pickers expose the custom-style manager and its required editor fields', () => {
  for (const id of [
    'customStylesBtn',
    'stageCustomStylesBtn',
    'customStylesModal',
    'customStylesCloseBtn',
    'customStyleNewBtn',
    'customStylesList',
    'customStyleTitle',
    'customStylePrompt',
    'customStyleCharacterInput',
    'customStyleWorldInput',
    'customStyleSaveBtn',
  ]) {
    assert.match(studioTemplate, new RegExp(`id="${id}"`));
    assert.match(appSource, new RegExp(`${id}:\\s*document\\.getElementById\\('${id}'\\)`));
  }
  assert.match(studioTemplate, /id="customStyleTitle"[^>]*required/);
  assert.match(appSource, /initCustomStylesController\(els/);
});
