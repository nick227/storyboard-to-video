const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const webRoot = path.join(__dirname, '..');
const topbarHtml = fs.readFileSync(path.join(webRoot, 'pages', 'partials', 'topbar.html'), 'utf8');
const workbarHtml = fs.readFileSync(path.join(webRoot, 'pages', 'partials', 'workbar.html'), 'utf8');
const topbarSource = fs.readFileSync(path.join(webRoot, 'public', 'js', 'shared', 'topbar.js'), 'utf8');

test('global topbar is product chrome only', () => {
  assert.match(topbarHtml, /href="\/library"/);
  assert.match(topbarHtml, />Library</);
  assert.doesNotMatch(topbarHtml, />Screenplay<|>Storyboard<|>Timeline<|>Download</);
  assert.doesNotMatch(topbarHtml, /data-page=/);
});

test('workbar carries artifact tabs and actions', () => {
  assert.match(workbarHtml, /data-artifact="screenplay"/);
  assert.match(workbarHtml, /data-artifact="storyboard"/);
  assert.match(workbarHtml, /data-artifact="timeline"/);
  assert.match(workbarHtml, /id="workShareBtn"/);
  assert.match(workbarHtml, /id="downloadZipBtn"/);
  assert.match(workbarHtml, /id="workTitleBtn"/);
});

test('studio and reader inject the workbar marker', () => {
  const studio = fs.readFileSync(path.join(webRoot, 'pages', 'studio.html'), 'utf8');
  const reader = fs.readFileSync(path.join(webRoot, 'pages', 'script-reader.html'), 'utf8');
  assert.match(studio, /<!--workbar-->/);
  assert.match(reader, /<!--workbar-->/);
  assert.equal((studio.match(/id="downloadZipBtn"/g) || []).length, 0);
});

test('topbar lazy-loads credits from their current module locations', () => {
  assert.match(topbarSource, /import\('\.\.\/billing\/credit-balance\.js'\)/);
  assert.match(topbarSource, /import\('\.\.\/core\/store\.js'\)/);
});

test('topbar owns shared tab styling and studio retains the download confirmation action', () => {
  const topbarCss = fs.readFileSync(path.join(webRoot, 'public', 'css', 'topbar.css'), 'utf8');
  const studio = fs.readFileSync(path.join(webRoot, 'pages', 'studio.html'), 'utf8');
  assert.match(topbarCss, /\.sf-artifact-tab\s*\{/);
  assert.equal((studio.match(/id="downloadConfirmRunBtn"/g) || []).length, 1);
});
