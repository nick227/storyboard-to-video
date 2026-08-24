const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

class FakeLine {
  constructor(format, height) {
    this.format = format;
    this.height = height;
    this.parentNode = null;
  }

  getAttribute(name) {
    return name === 'data-format' ? this.format : null;
  }
}

class FakePage {
  constructor(number, height = 100) {
    this.dataset = { pageNumber: String(number) };
    this.children = [];
    this.clientHeight = height;
    this.parentNode = null;
  }

  get scrollHeight() {
    return this.children.reduce((total, line) => total + line.height, 0);
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  get lastElementChild() {
    return this.children[this.children.length - 1] || null;
  }

  appendChild(line) {
    line.parentNode?.removeChild(line);
    this.children.push(line);
    line.parentNode = this;
    return line;
  }

  insertBefore(line, reference) {
    line.parentNode?.removeChild(line);
    const index = reference ? this.children.indexOf(reference) : -1;
    this.children.splice(index < 0 ? this.children.length : index, 0, line);
    line.parentNode = this;
    return line;
  }

  removeChild(line) {
    const index = this.children.indexOf(line);
    if (index >= 0) this.children.splice(index, 1);
    line.parentNode = null;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }
}

class FakeContainer {
  constructor(pages = []) {
    this.children = [];
    pages.forEach(page => this.appendChild(page));
  }

  appendChild(page) {
    this.children.push(page);
    page.parentNode = this;
    return page;
  }

  removeChild(page) {
    const index = this.children.indexOf(page);
    if (index >= 0) this.children.splice(index, 1);
    page.parentNode = null;
  }

  querySelectorAll(selector) {
    return selector === '.script-page' ? this.children.slice() : [];
  }
}

async function createManager(pages) {
  const modulePath = pathToFileURL(path.join(
    __dirname, '..', 'public', 'js', 'screenplay-editor', 'js', 'page', 'PageBreakManager.js',
  )).href;
  const { PageBreakManager } = await import(modulePath);
  const container = new FakeContainer(pages);
  const manager = {
    container,
    maxLinesPerPage: 54,
    getActiveLine: () => null,
    pageFactory: { createPage: number => new FakePage(number) },
  };
  return { container, pagination: new PageBreakManager(manager) };
}

test('height-aware pagination creates a new page instead of growing the first page', async () => {
  const firstPage = new FakePage(1);
  [30, 30, 30, 30].forEach(height => firstPage.appendChild(new FakeLine('action', height)));
  const { container, pagination } = await createManager([firstPage]);

  pagination.checkAndRecalculate();

  assert.equal(container.children.length, 2);
  assert.equal(container.children[0].children.length, 3);
  assert.equal(container.children[1].children.length, 1);
  assert.deepEqual(container.children.map(page => page.dataset.pageNumber), ['1', '2']);
});

test('pagination keeps a speaker and dialogue together when moving an overflowing tail', async () => {
  const firstPage = new FakePage(1);
  firstPage.appendChild(new FakeLine('action', 85));
  firstPage.appendChild(new FakeLine('speaker', 10));
  firstPage.appendChild(new FakeLine('dialog', 20));
  const { container, pagination } = await createManager([firstPage]);

  pagination.checkAndRecalculate();

  assert.deepEqual(container.children[0].children.map(line => line.format), ['action']);
  assert.deepEqual(container.children[1].children.map(line => line.format), ['speaker', 'dialog']);
});

test('pagination backfills and removes an empty trailing page after content shrinks', async () => {
  const firstPage = new FakePage(1);
  const secondPage = new FakePage(2);
  firstPage.appendChild(new FakeLine('action', 70));
  secondPage.appendChild(new FakeLine('action', 20));
  const { container, pagination } = await createManager([firstPage, secondPage]);

  pagination.checkAndRecalculate();

  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].children.length, 2);
});

test('a wrapped paragraph crossing the rendered boundary moves as one editable line', async () => {
  const firstPage = new FakePage(1);
  const lead = new FakeLine('action', 60);
  const wrapped = new FakeLine('action', 30);
  firstPage.appendChild(lead);
  firstPage.appendChild(wrapped);
  const { container, pagination } = await createManager([firstPage]);

  assert.equal(pagination.checkAndRecalculate(), false);
  wrapped.height = 50;
  pagination.checkAndRecalculate();

  assert.equal(container.children.length, 2);
  assert.equal(container.children[1].children[0], wrapped);
});

test('one large paste cascades across several pages in a single reflow', async () => {
  const firstPage = new FakePage(1);
  const pastedLines = Array.from({ length: 10 }, () => new FakeLine('action', 30));
  pastedLines.forEach(line => firstPage.appendChild(line));
  const { container, pagination } = await createManager([firstPage]);

  pagination.checkAndRecalculate();

  assert.deepEqual(container.children.map(page => page.children.length), [3, 3, 3, 1]);
  assert.deepEqual(container.children.flatMap(page => page.children), pastedLines);
});

test('removing content across several boundaries backfills all remaining pages', async () => {
  const firstPage = new FakePage(1);
  const lines = Array.from({ length: 10 }, () => new FakeLine('action', 30));
  lines.forEach(line => firstPage.appendChild(line));
  const { container, pagination } = await createManager([firstPage]);
  pagination.checkAndRecalculate();

  lines.slice(0, 6).forEach(line => line.parentNode.removeChild(line));
  pagination.checkAndRecalculate();

  assert.deepEqual(container.children.map(page => page.children.length), [3, 1]);
  assert.deepEqual(container.children.flatMap(page => page.children), lines.slice(6));
});

test('editing page one cascades reflow through every following page', async () => {
  const pages = [new FakePage(1), new FakePage(2), new FakePage(3)];
  const lines = Array.from({ length: 9 }, () => new FakeLine('action', 30));
  lines.forEach((line, index) => pages[Math.floor(index / 3)].appendChild(line));
  const { container, pagination } = await createManager(pages);

  lines[0].height = 60;
  pagination.checkAndRecalculate();

  assert.deepEqual(container.children.map(page => page.children.length), [2, 3, 3, 1]);
  assert.deepEqual(container.children.flatMap(page => page.children), lines);
});

test('a scene heading moves with its first action when the pair fits', async () => {
  const firstPage = new FakePage(1);
  firstPage.appendChild(new FakeLine('action', 85));
  firstPage.appendChild(new FakeLine('header', 10));
  firstPage.appendChild(new FakeLine('action', 10));
  const { container, pagination } = await createManager([firstPage]);

  pagination.checkAndRecalculate();

  assert.deepEqual(container.children[1].children.map(line => line.format), ['header', 'action']);
});

test('an oversized dialogue block splits instead of leaving an otherwise empty page', async () => {
  const firstPage = new FakePage(1);
  firstPage.appendChild(new FakeLine('action', 30));
  firstPage.appendChild(new FakeLine('speaker', 10));
  firstPage.appendChild(new FakeLine('dialog', 95));
  const { container, pagination } = await createManager([firstPage]);

  pagination.checkAndRecalculate();

  assert.deepEqual(container.children.map(page => page.children.map(line => line.format)), [
    ['action', 'speaker'],
    ['dialog'],
  ]);
});
