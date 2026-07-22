import { assertElements } from './dom-contract.js';

export function initSettingsController(elements, services = {}) {
  assertElements('Settings controller', elements, [
    'settingsBtn', 'settingsModal', 'planningMode', 'shotCount', 'shotLimit',
    'enrichNarration', 'commonPrompt', 'textProvider', 'videoMotionIntensity',
    'styleSelect', 'stageStyleSelect', 'characterRefInput', 'worldRefInput',
    'audioProvider', 'voiceLibraryModal', 'closeVoiceLibraryBtn',
    'voiceMicSelect', 'voiceRecordBtn', 'voiceSaveBtn', 'voiceNameInput',
    'tokensInfoBtn', 'tokensInfoModal', 'tokensCloseBtn', 'tokensDoneBtn',
  ]);

  const refreshShotCount = () => {
    const count = services.getShotCount();
    const limit = Number(elements.shotLimit.value) || null;
    const base = count ? `${count} shot${count === 1 ? '' : 's'}` : 'Not planned yet';
    elements.shotCount.textContent = limit ? `${base} (limit: ${limit})` : base;
  };
  const openSettings = async () => {
    elements.planningMode.value = elements.enrichNarration.checked ? 'auto' : 'script';
    refreshShotCount();
    services.refreshMediaSettings();
    await services.refreshVoices();
    services.renderVoices();
    elements.settingsModal.showModal();
  };

  elements.settingsBtn.addEventListener('click', openSettings);
  elements.settingsModal.querySelectorAll('[data-close-settings]').forEach((button) => {
    button.addEventListener('click', () => elements.settingsModal.close());
  });
  elements.settingsModal.addEventListener('click', (event) => {
    if (event.target === elements.settingsModal) elements.settingsModal.close();
  });

  elements.commonPrompt.addEventListener('input', () => {
    services.saveProject(false);
    services.renderStageBar();
  });
  [elements.textProvider, elements.videoMotionIntensity, elements.enrichNarration].forEach((element) => {
    element.addEventListener('change', () => services.saveProject(false));
  });
  elements.planningMode.addEventListener('change', () => {
    elements.enrichNarration.checked = elements.planningMode.value === 'auto';
    services.saveProject(false);
  });
  elements.shotLimit.addEventListener('change', () => {
    refreshShotCount();
    services.saveProject(false);
  });

  elements.styleSelect.addEventListener('change', async () => {
    if (elements.stageStyleSelect.value !== elements.styleSelect.value) {
      elements.stageStyleSelect.value = elements.styleSelect.value;
    }
    const styleId = elements.styleSelect.value;
    services.prefillCommonPrompt(styleId);
    services.saveProject(false);
    services.renderStageBar();
    await services.loadStyleReferences(styleId);
  });
  elements.stageStyleSelect.addEventListener('change', () => {
    if (elements.styleSelect.value === elements.stageStyleSelect.value) return;
    elements.styleSelect.value = elements.stageStyleSelect.value;
    elements.styleSelect.dispatchEvent(new Event('change'));
  });
  elements.characterRefInput.addEventListener('change', (event) => services.uploadStyleReferences('characters', event.target.files));
  elements.worldRefInput.addEventListener('change', (event) => services.uploadStyleReferences('world', event.target.files));

  elements.audioProvider.addEventListener('change', async (event) => {
    services.setAudioProvider(event.target.value);
    await services.refreshVoices();
    services.renderVoices();
    services.saveProject(false);
  });
  elements.closeVoiceLibraryBtn.addEventListener('click', () => elements.voiceLibraryModal.close());
  elements.voiceLibraryModal.addEventListener('click', (event) => {
    if (event.target === elements.voiceLibraryModal) elements.voiceLibraryModal.close();
  });
  elements.voiceLibraryModal.addEventListener('close', () => {
    services.closeVoiceLibrary();
    services.renderVoices();
  });
  elements.voiceMicSelect.addEventListener('change', () => services.switchMicrophone(elements.voiceMicSelect.value));
  elements.voiceRecordBtn.addEventListener('click', () => services.toggleVoiceRecording());
  elements.voiceSaveBtn.addEventListener('click', async () => {
    const blob = services.getRecordedVoice();
    if (!blob) return;
    const name = elements.voiceNameInput.value.trim();
    if (!name) return services.setStatus('Enter a name for this voice before saving.');
    elements.voiceSaveBtn.disabled = true;
    if (await services.cloneVoice(blob, name)) {
      services.resetVoiceRecording();
      services.renderVoiceLibrary();
      services.renderVoices();
    } else {
      elements.voiceSaveBtn.disabled = false;
    }
  });

  elements.tokensInfoBtn.addEventListener('click', () => {
    services.populateTokensInfo();
    elements.tokensInfoModal.showModal();
  });
  elements.tokensCloseBtn.addEventListener('click', () => elements.tokensInfoModal.close());
  elements.tokensDoneBtn.addEventListener('click', () => elements.tokensInfoModal.close());
  elements.tokensInfoModal.addEventListener('click', (event) => {
    if (event.target === elements.tokensInfoModal) elements.tokensInfoModal.close();
  });

  return {
    refreshShotCount,
    refreshTokensIfOpen: () => {
      if (elements.tokensInfoModal.open) services.populateTokensInfo();
    },
  };
}
