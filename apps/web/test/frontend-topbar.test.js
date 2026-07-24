const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const webRoot = path.join(__dirname, '..');
const topbarHtml = fs.readFileSync(path.join(webRoot, 'pages', 'partials', 'topbar.html'), 'utf8');
const topbarSource = fs.readFileSync(path.join(webRoot, 'public', 'js', 'shared', 'topbar.js'), 'utf8');

function enhance(pathname, search = '', savedPage = null) {
  const elementsById = new Map();
  const tabs = [];
  const pageTabs = {
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return this.attrs[name] ?? null; },
  };

  for (const match of topbarHtml.matchAll(/id="([^"]+)"/g)) {
    elementsById.set(match[1], {
      id: match[1],
      hidden: false,
      textContent: '',
      title: '',
      disabled: false,
      classList: { toggle() {} },
      setAttribute() {},
      addEventListener() {},
      dataset: {},
      tabIndex: 0,
    });
  }

  for (const match of topbarHtml.matchAll(/id="(tab\w+Btn)"[^>]*data-page="([^"]+)"[^>]*data-panel="([^"]+)"/g)) {
    const el = elementsById.get(match[1]);
    el.dataset = { page: match[2], panel: match[3] };
    el.classList = {
      state: new Set(['page-tab']),
      toggle(name, on) { if (on) this.state.add(name); else this.state.delete(name); },
      contains(name) { return this.state.has(name); },
    };
    el.attrs = {};
    el.setAttribute = (name, value) => { el.attrs[name] = String(value); };
    tabs.push(el);
  }

  const root = { sessionReady: null };
  const document = {
    querySelector(sel) {
      if (sel === '.sf-topbar') return root;
      if (sel === '.page-tabs') return pageTabs;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '.page-tab[data-page]') return tabs;
      return [];
    },
    getElementById(id) { return elementsById.get(id) || null; },
  };

  vm.runInNewContext(topbarSource, {
    document,
    window: { location: { pathname, search, href: 'http://localhost' } },
    localStorage: { getItem: () => savedPage, removeItem() {} },
    fetch: () => new Promise(() => {}),
    URLSearchParams,
  });

  return { tabs, pageTabs };
}

test('topbar partial is plain HTML with editable studio links', () => {
  assert.match(topbarHtml, /href="\/script"/);
  assert.match(topbarHtml, /href="\/storyboard"/);
  assert.match(topbarHtml, /href="\/timeline"/);
  assert.match(topbarHtml, /href="\/library"/);
  assert.match(topbarHtml, /id="downloadZipBtn"[^>]+href="\/storyboard\?download=1"/);
  assert.doesNotMatch(topbarHtml, /tabindex="-1"/);
  assert.doesNotMatch(topbarHtml, /studio\?page=/);
});

test('the Storyboard tab sits between Script and Timeline in tab order', () => {
  const scriptIndex = topbarHtml.indexOf('id="tabScriptBtn"');
  const storyboardIndex = topbarHtml.indexOf('id="tabStoryboardBtn"');
  const timelineIndex = topbarHtml.indexOf('id="tabTimelineBtn"');
  assert.ok(scriptIndex < storyboardIndex, 'Storyboard tab should come after Script');
  assert.ok(storyboardIndex < timelineIndex, 'Timeline tab should come after Storyboard');
  assert.doesNotMatch(topbarHtml, /id="tabNarrationBtn"/);
  assert.doesNotMatch(topbarHtml, /id="tabStyleBtn"/);
});

test('enhancer restores studio tab semantics and the saved active page', () => {
  const { tabs, pageTabs } = enhance('/script');
  assert.equal(pageTabs.getAttribute('role'), 'tablist');
  const script = tabs.find((tab) => tab.dataset.page === 'script');
  assert.ok(script.classList.contains('is-active'));
  assert.equal(script.attrs.role, 'tab');
  assert.equal(script.attrs['aria-selected'], 'true');
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

test('pages include the topbar marker for server injection', () => {
  const studio = fs.readFileSync(path.join(webRoot, 'pages', 'studio.html'), 'utf8');
  assert.match(studio, /<!--topbar-->/);
  assert.doesNotMatch(studio, /storyboarder-topbar/);
});
