const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const controllerPromise = import(path.join(__dirname, '..', 'public', 'modules', 'image-library-controller.js'));
const storePromise = import(path.join(__dirname, '..', 'public', 'modules', 'store.js'));

test('image library request contexts reject stale modal and project responses', async () => {
  const [{ ImageLibraryController }, { projectStore }] = await Promise.all([controllerPromise, storePromise]);
  const controller = new ImageLibraryController();
  controller.dom = { modal: { open: true } };
  controller.state = {
    token: 7,
    projectId: 'project-a',
    mode: 'scene-image',
    styleId: 'style-a',
    sceneId: 'scene-a',
    domEls: { styleSelect: { value: 'style-a' } },
  };
  projectStore.set({ storyboards: [], currentId: 'project-a' });
  const { sceneStore } = await storePromise;
  sceneStore.set({ scenes: [{ id: 'scene-a' }] });

  try {
    const context = controller.context();
    assert.equal(controller.isCurrent(context), true);

    controller.state = { ...controller.state, sceneId: 'scene-b', token: 8 };
    assert.equal(controller.isCurrent(context), false);

    controller.state = { ...controller.state, ...context };
    controller.state.domEls.styleSelect.value = 'style-b';
    assert.equal(controller.isCurrent(context), false);

    controller.state.domEls.styleSelect.value = 'style-a';
    projectStore.set({ storyboards: [], currentId: 'project-b' });
    assert.equal(controller.isCurrent(context), false);

    projectStore.set({ storyboards: [], currentId: 'project-a' });
    controller.dom.modal.open = false;
    assert.equal(controller.isCurrent(context), false);
  } finally {
    projectStore.set({ storyboards: [], currentId: null });
    sceneStore.set({ scenes: [] });
  }
});

test('image library initialization is idempotent and does not duplicate listeners', async () => {
  const { ImageLibraryController } = await controllerPromise;
  let listenerCount = 0;
  const control = () => ({
    dataset: {},
    style: {},
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() { listenerCount++; },
    querySelectorAll() { return []; },
  });
  const controls = new Map();
  const byId = (id) => {
    if (!controls.has(id)) controls.set(id, control());
    return controls.get(id);
  };
  const tab = control();
  tab.dataset.tab = 'uploads';
  const pane = control();
  const modal = {
    ...control(),
    querySelector(selector) {
      if (selector.startsWith('#')) return byId(selector.slice(1));
      return control();
    },
    querySelectorAll(selector) {
      return selector.includes('tab-btn') ? [tab] : [pane];
    },
  };
  const originalDocument = global.document;
  global.document = { getElementById: () => modal };
  const domEls = { characterRefLibraryBtn: control(), worldRefLibraryBtn: control(), styleSelect: { value: 'style-a' } };

  try {
    const controller = new ImageLibraryController();
    controller.init(domEls, () => {}, { renderStyleReferences() {} });
    const firstCount = listenerCount;
    controller.init(domEls, () => {}, { renderStyleReferences() {} });
    assert.ok(firstCount > 0);
    assert.equal(listenerCount, firstCount);
  } finally {
    global.document = originalDocument;
  }
});

test('invalidating the image library aborts requests and revokes every modal-owned preview URL', async () => {
  const { ImageLibraryController } = await controllerPromise;
  const controller = new ImageLibraryController();
  const abortController = new AbortController();
  controller.contextAbortController = abortController;
  controller.previewScopes.set('active', { generation: 1, urls: new Set(['blob:active']) });
  controller.previewScopes.set('uploads', { generation: 1, urls: new Set(['blob:upload']) });
  const originalRevoke = URL.revokeObjectURL;
  const revoked = [];
  URL.revokeObjectURL = (url) => revoked.push(url);

  try {
    controller.invalidate();
    assert.equal(abortController.signal.aborted, true);
    assert.deepEqual(revoked.sort(), ['blob:active', 'blob:upload']);
    assert.equal(controller.previewScopes.get('active').urls.size, 0);
    assert.equal(controller.previewScopes.get('uploads').urls.size, 0);
  } finally {
    URL.revokeObjectURL = originalRevoke;
  }
});

test('stale generation and upload responses cannot start follow-up scene or style mutations', async () => {
  const [{ ImageLibraryController }, { projectStore, sceneStore }] = await Promise.all([controllerPromise, storePromise]);
  const originalFetch = global.fetch;
  projectStore.set({ storyboards: [], currentId: 'project-a' });
  sceneStore.set({ scenes: [{ id: 'scene-a' }] });

  try {
    for (const operation of ['generate', 'upload']) {
      let resolveResponse;
      let fetchCount = 0;
      global.fetch = () => {
        fetchCount++;
        return new Promise((resolve) => { resolveResponse = resolve; });
      };
      const controller = new ImageLibraryController();
      controller.contextAbortController = new AbortController();
      controller.state = {
        token: 1,
        projectId: 'project-a',
        mode: 'scene-image',
        styleId: '',
        sceneId: 'scene-a',
        setStatus() {},
      };
      controller.dom = {
        modal: { open: true },
        promptTextarea: { value: 'A reference image' },
        useStoryCheckbox: { checked: false },
        providerSelect: { value: 'stub' },
        controls: { classList: { add() {}, remove() {} } },
      };

      const pending = operation === 'generate'
        ? controller.generate()
        : controller.upload({ target: { files: [new Blob(['image'])], value: 'selected' } });
      controller.state = { ...controller.state, token: 2, sceneId: 'scene-b' };
      resolveResponse({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(operation === 'generate'
          ? { path: '/generated.png', fileName: 'generated.png' }
          : { files: [{ path: '/uploaded.png', fileName: 'uploaded.png' }] }),
      });
      await pending;

      assert.equal(fetchCount, 1, `${operation} should not issue refresh or attachment mutations after its context becomes stale`);
    }
  } finally {
    global.fetch = originalFetch;
    projectStore.set({ storyboards: [], currentId: null });
    sceneStore.set({ scenes: [] });
  }
});
