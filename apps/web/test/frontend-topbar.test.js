const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const webRoot = path.join(__dirname, '..');
const topbarHtml = fs.readFileSync(path.join(webRoot, 'pages', 'partials', 'topbar.html'), 'utf8');
const workbarHtml = fs.readFileSync(path.join(webRoot, 'pages', 'partials', 'workbar.html'), 'utf8');
const topbarSource = fs.readFileSync(path.join(webRoot, 'public', 'js', 'shared', 'topbar.js'), 'utf8');

test('global topbar carries stable script controls, mode tabs, and account chrome', () => {
  assert.match(topbarHtml, /href="\/library"/);
  assert.match(topbarHtml, /id="storyboardTitle"/);
  assert.match(topbarHtml, /id="newStoryboardBtn"/);
  assert.match(topbarHtml, /id="scriptMenuToggle"/);
  assert.match(topbarHtml, /id="workVisibilityToggle"/);
  assert.match(topbarHtml, /data-artifact="screenplay"/);
  assert.match(topbarHtml, /data-artifact="storyboard"/);
  assert.match(topbarHtml, /data-artifact="timeline"/);
  assert.match(topbarHtml, /id="authLoggedIn"/);
  assert.doesNotMatch(topbarHtml, /id="logoutBtn"|class="sf-logout"/);
  assert.doesNotMatch(topbarSource, /logoutBtn|api\/auth\/logout/);
});

test('legacy workbar remains an empty hidden mount point', () => {
  assert.match(workbarHtml, /class="sf-workbar" hidden/);
  assert.doesNotMatch(workbarHtml, /data-artifact=|<button|<a\b/);
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

test('workbar stays hidden outside edit routes', () => {
  const workbarSource = fs.readFileSync(path.join(webRoot, 'public', 'js', 'shared', 'workbar.js'), 'utf8');
  assert.match(workbarSource, /!route\.edit/);
  assert.match(workbarSource, /View mode is read-only/);
});

test('topbar owns shared tab styling and studio retains the download confirmation action', () => {
  const topbarCss = fs.readFileSync(path.join(webRoot, 'public', 'css', 'topbar.css'), 'utf8');
  let studio = fs.readFileSync(path.join(webRoot, 'pages', 'studio.html'), 'utf8');
  // Expand dialog partials in studio so that downloadConfirmRunBtn is resolved
  const dialogRegex = /<!--dialogs\/([a-zA-Z0-9_-]+)-->/g;
  studio = studio.replace(dialogRegex, (match, slug) => {
    const dialogPath = path.join(webRoot, 'pages', 'partials', 'dialogs', `${slug}.html`);
    if (fs.existsSync(dialogPath)) {
      return fs.readFileSync(dialogPath, 'utf8').trim();
    }
    return match;
  });
  assert.match(topbarCss, /\.sf-artifact-tab\s*\{/);
  assert.equal((studio.match(/id="downloadConfirmRunBtn"/g) || []).length, 1);
});
