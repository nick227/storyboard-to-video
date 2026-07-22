const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const controllerPromise = import(path.join(__dirname, '..', 'public', 'modules', 'settings-controller.js'));

test('settings controller validates its required feature controls', async () => {
  const { initSettingsController } = await controllerPromise;
  assert.throws(
    () => initSettingsController({}),
    /Settings controller is missing required DOM bindings:.*settingsBtn.*tokensDoneBtn/,
  );
});

test('settings controller owns planning-mode synchronization and a single settings opener', async () => {
  const { initSettingsController } = await controllerPromise;
  const element = (extra = {}) => ({
    listeners: {}, value: '', checked: false, textContent: '',
    addEventListener(type, handler) { this.listeners[type] = handler; },
    dispatchEvent() {}, close() {}, showModal() {},
    querySelectorAll() { return []; },
    ...extra,
  });
  const names = [
    'settingsBtn', 'settingsModal', 'planningMode', 'shotCount', 'shotLimit',
    'enrichNarration', 'commonPrompt', 'textProvider', 'videoMotionIntensity',
    'styleSelect', 'stageStyleSelect', 'characterRefInput', 'worldRefInput',
    'audioProvider', 'voiceLibraryModal', 'closeVoiceLibraryBtn',
    'voiceMicSelect', 'voiceRecordBtn', 'voiceSaveBtn', 'voiceNameInput',
    'tokensInfoBtn', 'tokensInfoModal', 'tokensCloseBtn', 'tokensDoneBtn',
  ];
  const elements = Object.fromEntries(names.map((name) => [name, element()]));
  let saveCount = 0;
  const noop = () => {};
  const services = {
    getShotCount: () => 3,
    refreshMediaSettings: noop,
    saveProject: () => { saveCount++; },
    refreshVoices: async () => {},
    renderVoices: noop,
    renderStageBar: noop,
    prefillCommonPrompt: noop,
    loadStyleReferences: async () => {},
    uploadStyleReferences: noop,
    setAudioProvider: noop,
    closeVoiceLibrary: noop,
    switchMicrophone: noop,
    toggleVoiceRecording: noop,
    getRecordedVoice: () => null,
    cloneVoice: async () => true,
    resetVoiceRecording: noop,
    renderVoiceLibrary: noop,
    populateTokensInfo: noop,
    setStatus: noop,
  };

  initSettingsController(elements, services);
  elements.planningMode.value = 'auto';
  elements.planningMode.listeners.change();

  assert.equal(elements.enrichNarration.checked, true);
  assert.equal(saveCount, 1);
  assert.equal(typeof elements.settingsBtn.listeners.click, 'function');
});
