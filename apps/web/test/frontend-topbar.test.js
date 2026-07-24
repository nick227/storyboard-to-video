const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const webRoot = path.join(__dirname, '..');
const topbarSource = fs.readFileSync(path.join(webRoot, 'public', 'js', 'shared', 'topbar.js'), 'utf8');

function createNode(tagName) {
  const attrs = Object.create(null);
  const node = {
    tagName: String(tagName).toUpperCase(),
    children: [],
    textContent: '',
    hidden: false,
    setAttribute(name, value) { attrs[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    append(...parts) {
      for (const part of parts) {
        if (part == null) continue;
        if (typeof part === 'string' || typeof part === 'number') {
          this.children.push({ text: String(part) });
          this.textContent += String(part);
        } else {
          this.children.push(part);
        }
      }
    },
    replaceChildren(...parts) {
      this.children = [];
      this.textContent = '';
      this.append(...parts);
    },
  };
  Object.defineProperty(node, 'className', {
    get() { return attrs.class || ''; },
    set(value) { attrs.class = String(value); },
  });
  Object.defineProperty(node, 'innerHTML', {
    get() { return this.children.map(serialize).join(''); },
    set(value) {
      this.children = [{ text: String(value) }];
      this.textContent = String(value);
    },
  });
  node.dataset = new Proxy(Object.create(null), {
    set(target, key, value) {
      target[key] = value;
      attrs[`data-${String(key)}`] = String(value);
      return true;
    },
    get(target, key) { return target[key]; },
  });
  node._attrs = attrs;
  return node;
}

function serialize(node) {
  if (node.text != null) return node.text;
  const tag = node.tagName.toLowerCase();
  const attrs = Object.entries(node._attrs)
    .map(([name, value]) => (value === '' ? ` ${name}` : ` ${name}="${value}"`))
    .join('');
  return `<${tag}${attrs}>${node.children.map(serialize).join('')}</${tag}>`;
}

function renderTopbar(pathname, search = '', savedPage = null) {
  let Topbar;
  class HTMLElement {
    constructor() {
      this.dataset = {};
      this.children = [];
    }
    replaceChildren(...parts) {
      this.children = parts;
    }
    get innerHTML() {
      return this.children.map(serialize).join('');
    }
    querySelector() {
      return { hidden: false, addEventListener() {}, textContent: '', title: '' };
    }
  }
  const context = {
    HTMLElement,
    URLSearchParams,
    document: { createElement: createNode },
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

test('the Storyboard and Style tabs sit between Script and Timeline in tab order', () => {
  const markup = renderTopbar('/admin');
  const scriptIndex = markup.indexOf('id="tabScriptBtn"');
  const storyboardIndex = markup.indexOf('id="tabStoryboardBtn"');
  const styleIndex = markup.indexOf('id="tabStyleBtn"');
  const timelineIndex = markup.indexOf('id="tabTimelineBtn"');
  assert.ok(scriptIndex < storyboardIndex, 'Storyboard tab should come after Script');
  assert.ok(storyboardIndex < styleIndex, 'Style tab should come after Storyboard');
  assert.ok(styleIndex < timelineIndex, 'Timeline tab should come after Style');
  assert.doesNotMatch(markup, /id="tabNarrationBtn"/);
});

test('topbar restores studio tab semantics and the saved active page in studio', () => {
  const markup = renderTopbar('/studio', '', 'script');
  assert.match(markup, /class="page-tabs"[^>]*role="tablist"/);
  assert.match(markup, /id="tabScriptBtn"[^>]*class="page-tab is-active"[^>]*role="tab"[^>]*aria-selected="true"/);
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
