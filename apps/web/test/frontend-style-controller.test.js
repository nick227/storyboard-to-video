const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const controllerPromise = import(path.join(__dirname, '..', 'public', 'modules', 'style-controller.js'));
const storePromise = import(path.join(__dirname, '..', 'public', 'modules', 'store.js'));

function element(extra = {}) {
  return {
    listeners: {}, value: '', disabled: false, textContent: '', hidden: true,
    addEventListener(type, handler) { this.listeners[type] = handler; },
    dispatchEvent(event) { this.listeners[event.type]?.(event); },
    querySelectorAll() { return []; },
    close() {}, showModal() {}, focus() {},
    ...extra,
  };
}

test('style controller validates its required feature controls', async () => {
  const { initStyleController } = await controllerPromise;
  assert.throws(
    () => initStyleController({}),
    /Style controller is missing required DOM bindings:.*styleSelect.*styleRefLightbox.*styleRefLightboxImage/,
  );
});

test('changing the preset prefills the prompt, saves, and mirrors into the stage-bar select', async () => {
  const { initStyleController } = await controllerPromise;
  const elements = {
    styleSelect: element({ value: 'cinematic' }),
    stageStyleSelect: element({ value: '' }),
    commonPromptText: element(),
    characterRefInput: element(),
    worldRefInput: element(),
    characterRefs: element(),
    worldRefs: element(),
    styleReferencesPanel: element(),
    styleRefLightbox: element(),
    styleRefLightboxImage: element(),
  };
  let prefilledWith = null;
  let saveCount = 0;
  let loadedReferencesFor = null;
  initStyleController(elements, {
    prefillCommonPrompt: (styleId) => { prefilledWith = styleId; },
    saveProject: () => { saveCount++; },
    renderStageBar: () => {},
    loadStyleReferences: async (styleId) => { loadedReferencesFor = styleId; },
    uploadStyleReferences: () => {},
    setStatus: () => {},
  });

  await elements.styleSelect.listeners.change();

  assert.equal(prefilledWith, 'cinematic');
  assert.equal(saveCount, 1);
  assert.equal(loadedReferencesFor, 'cinematic');
  assert.equal(elements.stageStyleSelect.value, 'cinematic');
});



test('reordering a reference persists record.styleReferenceOrder and refreshes references for the current style', async () => {
  const { initStyleController } = await controllerPromise;
  const { projectStore, generationStore } = await storePromise;
  const record = { id: 'p1', styleId: 's1' };
  projectStore.set({ currentId: 'p1', storyboards: [record] });
  generationStore.set({ styleReferences: { characters: [{ fileName: 'a.png' }, { fileName: 'b.png' }], world: [] } });

  const elements = {
    styleSelect: element({ value: 's1' }),
    stageStyleSelect: element(),
    commonPromptText: element(),
    characterRefInput: element(),
    worldRefInput: element(),
    characterRefs: element(),
    worldRefs: element(),
    styleReferencesPanel: element(),
    styleRefLightbox: element(),
    styleRefLightboxImage: element(),
  };
  let loadedReferencesFor = null;
  initStyleController(elements, {
    prefillCommonPrompt: () => {},
    saveProject: () => {},
    renderStageBar: () => {},
    loadStyleReferences: async (styleId) => { loadedReferencesFor = styleId; },
    uploadStyleReferences: () => {},
    setStatus: () => {},
  });

  await elements.onStyleReferenceReorder('characters', 'b.png', 'up');

  assert.deepEqual(record.styleReferenceOrder.characters, ['b.png', 'a.png']);
  assert.equal(loadedReferencesFor, 's1');
});
