const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const webRoot = path.join(__dirname, '..');
const topbarSource = fs.readFileSync(path.join(webRoot, 'public', 'js', 'shared', 'topbar.js'), 'utf8');

function renderTopbar(pathname, search = '', savedPage = null) {
  let Topbar;
  class HTMLElement {
    constructor() {
      this.dataset = {};
      this.innerHTML = '';
    }
  }
  const context = {
    HTMLElement,
    URLSearchParams,
    window: { location: { pathname, search } },
    localStorage: { getItem: () => savedPage },
    customElements: {
      get: () => null,
      define: (_name, constructor) => { Topbar = constructor; },
    },
    fetch: () => new Promise(() => {}),
  };
  vm.runInNewContext(topbarSource, context);
  const topbar = new Topbar();
  topbar.connectedCallback();
  return topbar.innerHTML;
}

test('topbar studio pages are real cross-page links outside the studio', () => {
  const markup = renderTopbar('/admin');
  assert.match(markup, /href="\/studio\?page=script"/);
  assert.match(markup, /href="\/studio\?page=storyboard"/);
  assert.match(markup, /href="\/studio\?page=timeline"/);
  assert.match(markup, /id="downloadZipBtn"[^>]+href="\/studio\?download=1"/);
  assert.doesNotMatch(markup, /id="tabScriptBtn"[^>]+tabindex="-1"/);
});

test('the Storyboard tab sits between Script and Timeline in tab order', () => {
  const markup = renderTopbar('/admin');
  const scriptIndex = markup.indexOf('id="tabScriptBtn"');
  const storyboardIndex = markup.indexOf('id="tabStoryboardBtn"');
  const timelineIndex = markup.indexOf('id="tabTimelineBtn"');
  assert.ok(scriptIndex < storyboardIndex, 'Storyboard tab should come after Script');
  assert.ok(storyboardIndex < timelineIndex, 'Timeline tab should come after Storyboard');
  assert.doesNotMatch(markup, /id="tabNarrationBtn"/);
  assert.doesNotMatch(markup, /id="tabStyleBtn"/);
});

test('topbar restores studio tab semantics and the saved active page in studio', () => {
  const markup = renderTopbar('/studio', '', 'script');
  assert.match(markup, /class="page-tabs" role="tablist"/);
  assert.match(markup, /id="tabScriptBtn" class="page-tab is-active" role="tab"[^>]+aria-selected="true"/);
});

test('topbar owns shared tab styling and studio retains the download confirmation action', () => {
  const topbarCss = fs.readFileSync(path.join(webRoot, 'public', 'css', 'topbar.css'), 'utf8');
  const studio = fs.readFileSync(path.join(webRoot, 'pages', 'studio.html'), 'utf8');
  assert.match(topbarCss, /\.page-tab\s*\{/);
  assert.equal((studio.match(/id="downloadZipBtn"/g) || []).length, 0);
  assert.equal((studio.match(/id="downloadConfirmRunBtn"/g) || []).length, 1);
});

test('topbar lazy-loads credits from their current module locations', () => {
  assert.match(topbarSource, /import\('\.\.\/billing\/credit-balance\.js'\)/);
  assert.match(topbarSource, /import\('\.\.\/core\/store\.js'\)/);
});
