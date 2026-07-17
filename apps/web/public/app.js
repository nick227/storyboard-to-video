import { projectStore, sceneStore, voiceStore, uiStore, batchStore } from './modules/store.js';
import { restoreStoryboardLibrary, openStoryboard, createStoryboard, saveStoryboard, getCurrentStoryboardRecord } from './modules/persistence.js';
import { initRendering } from './modules/rendering.js';
import { initTimeline } from './modules/timeline.js';
import { renderStoryboardPicker, loadStyles, loadStyleReferences, uploadStyleReferences, prefillCommonPrompt, renderVoicesPanel, updateButtons } from './modules/ui.js';
import { generatePrompts, generateDialogue, downloadZip, regenerateImage, regenerateAudio, regenerateVideo } from './modules/workflows.js';
import { batchController } from './modules/batch.js';
import { suggestSceneCount } from './modules/scene-count.js';
import {
  loadElevenLabsVoices, loadSparkVoices, cloneVoice, switchMicrophone,
  openVoiceLibraryModal, closeVoiceLibraryCleanup, toggleVoiceRecording,
  renderVoiceLibraryList, resetVoiceRecordingUI, voiceRecordingState,
} from './modules/voices.js';

const els = {
  // Elements
  scriptText: document.getElementById('scriptText'),
  sceneCount: document.getElementById('sceneCount'),
  autoSceneCountBtn: document.getElementById('autoSceneCountBtn'),
  styleSelect: document.getElementById('styleSelect'),
  commonPromptText: document.getElementById('commonPromptText'),
  textProvider: document.getElementById('textProvider'),
  imageProvider: document.getElementById('imageProvider'),
  audioProvider: document.getElementById('audioProvider'),
  videoMotionIntensity: document.getElementById('videoMotionIntensity'),
  fallbackPolicy: document.getElementById('fallbackPolicy'),
  statusText: document.getElementById('statusText'),
  generationSummaryText: document.getElementById('generationSummaryText'),
  storyboardGrid: document.getElementById('storyboardGrid'),
  resizeSceneList: document.querySelector('.resize-scene-list'),
  sceneCardTemplate: document.getElementById('sceneCardTemplate'),
  
  // Navigation / Actions
  storyboardTitle: document.getElementById('storyboardTitle'),
  storyboardPicker: document.getElementById('storyboardPicker'),
  newStoryboardBtn: document.getElementById('newStoryboardBtn'),
  saveStateBtn: document.getElementById('saveStateBtn'),
  downloadZipBtn: document.getElementById('downloadZipBtn'),
  
  // Generation Buttons
  generatePromptsBtn: document.getElementById('generatePromptsBtn'),
  startSerialBtn: document.getElementById('startSerialBtn'),
  generateDialogueBtn: document.getElementById('generateDialogueBtn'),
  startAudioSerialBtn: document.getElementById('startAudioSerialBtn'),
  startVideoSerialBtn: document.getElementById('startVideoSerialBtn'),

  // Settings modals
  commonPromptSettingsBtn: document.getElementById('commonPromptSettingsBtn'),
  commonPromptModal: document.getElementById('commonPromptModal'),
  styleReferencesSettingsBtn: document.getElementById('styleReferencesSettingsBtn'),
  styleReferencesModal: document.getElementById('styleReferencesModal'),
  audioSettingsBtn: document.getElementById('audioSettingsBtn'),
  audioSettingsModal: document.getElementById('audioSettingsModal'),

  // Generation preflight
  generationConfirmModal: document.getElementById('generationConfirmModal'),
  generationConfirmTitle: document.getElementById('generationConfirmTitle'),
  generationConfirmIntro: document.getElementById('generationConfirmIntro'),
  generationConfirmScope: document.getElementById('generationConfirmScope'),
  generationConfirmPrevious: document.getElementById('generationConfirmPrevious'),
  generationConfirmImpact: document.getElementById('generationConfirmImpact'),
  generationConfirmCloseBtn: document.getElementById('generationConfirmCloseBtn'),
  generationConfirmCancelBtn: document.getElementById('generationConfirmCancelBtn'),
  generationConfirmRunBtn: document.getElementById('generationConfirmRunBtn'),
  
  // References
  characterRefs: document.getElementById('characterRefs'),
  worldRefs: document.getElementById('worldRefs'),
  characterRefInput: document.getElementById('characterRefInput'),
  worldRefInput: document.getElementById('worldRefInput'),
  
  // Voice Cloning
  voiceCloningBtn: document.getElementById('voiceCloningBtn'),
  voicesPanel: document.getElementById('voicesPanel'),
  voiceLibraryModal: document.getElementById('voiceLibraryModal'),
  closeVoiceLibraryBtn: document.getElementById('closeVoiceLibraryBtn'),
  voiceLibraryList: document.getElementById('voiceLibraryList'),
  voiceMicSelect: document.getElementById('voiceMicSelect'),
  voiceMicStatus: document.getElementById('voiceMicStatus'),
  voiceWaveformCanvas: document.getElementById('voiceWaveformCanvas'),
  voiceRecordBtn: document.getElementById('voiceRecordBtn'),
  voiceRecordPreview: document.getElementById('voiceRecordPreview'),
  voiceDurationNote: document.getElementById('voiceDurationNote'),
  voiceNameInput: document.getElementById('voiceNameInput'),
  voiceSaveBtn: document.getElementById('voiceSaveBtn'),

  // Regeneration confirmation
  confirmRegenModal: document.getElementById('confirmRegenModal'),
  confirmRegenMessage: document.getElementById('confirmRegenMessage'),
  confirmRegenCancelBtn: document.getElementById('confirmRegenCancelBtn'),
  confirmRegenConfirmBtn: document.getElementById('confirmRegenConfirmBtn'),

  // Scene entity modal
  entityModal: document.getElementById('entityModal'),
  entityModalSceneLabel: document.getElementById('entityModalSceneLabel'),
  entityModalTitle: document.getElementById('entityModalTitle'),
  closeEntityModalBtn: document.getElementById('closeEntityModalBtn'),
  entityModalBeatField: document.getElementById('entityModalBeatField'),
  entityModalBeat: document.getElementById('entityModalBeat'),
  entityModalRegenBeatBtn: document.getElementById('entityModalRegenBeatBtn'),
  entityModalTextField: document.getElementById('entityModalTextField'),
  entityModalTextFieldLabel: document.getElementById('entityModalTextFieldLabel'),
  entityModalTextarea: document.getElementById('entityModalTextarea'),
  entityModalTextHint: document.getElementById('entityModalTextHint'),
  entityModalRegenTextBtn: document.getElementById('entityModalRegenTextBtn'),
  entityModalStaleWarning: document.getElementById('entityModalStaleWarning'),
  entityModalMedia: document.getElementById('entityModalMedia'),
  entityModalImage: document.getElementById('entityModalImage'),
  entityModalVideo: document.getElementById('entityModalVideo'),
  entityModalAudio: document.getElementById('entityModalAudio'),
  entityModalMediaEmpty: document.getElementById('entityModalMediaEmpty'),
  entityModalStatus: document.getElementById('entityModalStatus'),
  entityModalRegenBtn: document.getElementById('entityModalRegenBtn'),
  entityModalHistory: document.getElementById('entityModalHistory'),
  entityModalHistoryCount: document.getElementById('entityModalHistoryCount'),
  entityModalHistoryList: document.getElementById('entityModalHistoryList'),

  // Timeline
  timelineSection: document.getElementById('timelineSection'),
  timelineVideo: document.getElementById('timelineVideo'),
  timelineVideoB: document.getElementById('timelineVideoB'),
  timelineImage: document.getElementById('timelineImage'),
  timelineStageEmpty: document.getElementById('timelineStageEmpty'),
  timelineAudio: document.getElementById('timelineAudio'),
  timelineAudioB: document.getElementById('timelineAudioB'),
  timelineToggle: document.getElementById('timelineToggle'),
  timelineTime: document.getElementById('timelineTime'),
  timelineTrackWrap: document.getElementById('timelineTrackWrap'),
  timelineTrackInner: document.getElementById('timelineTrackInner'),
  timelineThumbs: document.getElementById('timelineThumbs'),
  timelineWaveformCanvas: document.getElementById('timelineWaveformCanvas'),
  timelinePlayhead: document.getElementById('timelinePlayhead'),
  timelineMute: document.getElementById('timelineMute'),
  timelineVolumeSlider: document.getElementById('timelineVolumeSlider'),
};

let generationConfirmResolve = null;

function setStatus(msg) {
  if (els.statusText) els.statusText.textContent = msg;
}

function selectedLabel(select) {
  return select.selectedOptions?.[0]?.textContent?.trim() || select.value;
}

function getGenerationPreflight(kind) {
  const scenes = sceneStore.get().scenes;
  const total = scenes.length;
  const readyCount = (predicate) => scenes.filter(predicate).length;
  const versionStats = (key) => ({
    scenes: readyCount((scene) => (scene[key] || []).some((version) => version?.path)),
    versions: scenes.reduce((sum, scene) => sum + (scene[key] || []).filter((version) => version?.path).length, 0),
  });
  const prompts = readyCount((scene) => Boolean(String(scene.prompt || '').trim()));
  const dialogue = readyCount((scene) => (scene.lines || []).some((line) => String(line?.text || '').trim()));
  const lines = scenes.reduce((sum, scene) => sum + (scene.lines || []).filter((line) => String(line?.text || '').trim()).length, 0);
  const images = versionStats('versions');
  const audio = versionStats('audioVersions');
  const video = versionStats('videoVersions');

  const configurations = {
    prompts: {
      title: 'Generate prompts?',
      intro: 'This rebuilds the project-wide scene writing from the current story.',
      scope: `${Number(els.sceneCount.value) || 1} scenes using ${selectedLabel(els.textProvider)} and the current common prompt.`,
      previous: prompts
        ? `${prompts}/${total} current scenes have prompts. Downstream work: ${images.versions} image version${images.versions === 1 ? '' : 's'}, ${audio.versions} audio version${audio.versions === 1 ? '' : 's'}, and ${video.versions} video version${video.versions === 1 ? '' : 's'}.`
        : `No current scene prompts exist.${images.versions || audio.versions || video.versions ? ` Existing downstream work includes ${images.versions} image, ${audio.versions} audio, and ${video.versions} video versions.` : ''}`,
      impact: prompts
        ? 'Scene structure and prompt text will be rebuilt. Dialogue and audio associations will be replaced. Existing image and video versions are retained by scene position and should be reviewed afterward.'
        : 'Creates the initial scene structure and visual prompts. You can edit individual scenes after generation.',
      confirmLabel: 'Generate prompts',
    },
    dialogue: {
      title: 'Generate dialogue?',
      intro: 'This organizes dialogue and narration across every current scene.',
      scope: `${total} scenes using ${selectedLabel(els.textProvider)}.`,
      previous: dialogue
        ? `${dialogue}/${total} scenes currently contain ${lines} dialogue line${lines === 1 ? '' : 's'}. ${audio.versions} audio version${audio.versions === 1 ? '' : 's'} already exist.`
        : `No current dialogue exists.${audio.versions ? ` ${audio.versions} stored audio version${audio.versions === 1 ? '' : 's'} may be associated with earlier dialogue.` : ''}`,
      impact: dialogue
        ? 'Current speaker lines will be replaced for all scenes. Existing audio is kept, but may no longer match and should be generated again.'
        : 'Adds speaker lines to every scene and unlocks project-wide audio generation.',
      confirmLabel: 'Generate dialogue',
    },
    images: {
      title: 'Generate images?',
      intro: 'This runs image generation sequentially across every scene.',
      scope: `${total} scenes using ${selectedLabel(els.imageProvider)} with the selected style and references.`,
      previous: images.versions
        ? `${images.scenes}/${total} scenes already have ${images.versions} stored image version${images.versions === 1 ? '' : 's'}.`
        : 'No images have been generated for these scenes yet.',
      impact: 'Creates and selects a new image version for each scene. Existing image versions remain available in history.',
      confirmLabel: 'Generate images',
    },
    audio: {
      title: 'Generate audio?',
      intro: 'This renders the current dialogue sequentially for every scene.',
      scope: `${total} scenes using ${selectedLabel(els.audioProvider)} and the current speaker assignments.`,
      previous: audio.versions
        ? `${audio.scenes}/${total} scenes already have ${audio.versions} stored audio version${audio.versions === 1 ? '' : 's'}.`
        : 'No audio has been generated for these scenes yet.',
      impact: 'Creates and selects a new audio version for each scene. Existing audio versions remain available in history.',
      confirmLabel: 'Generate audio',
    },
    videos: {
      title: 'Generate videos?',
      intro: 'This animates each scene from its currently selected image.',
      scope: `${total} scenes using ${selectedLabel(els.videoMotionIntensity)} motion intensity.`,
      previous: video.versions
        ? `${video.scenes}/${total} scenes already have ${video.versions} stored video version${video.versions === 1 ? '' : 's'}.`
        : 'No videos have been generated for these scenes yet.',
      impact: 'Creates and selects a new video version for each scene. Existing video versions remain available in history.',
      confirmLabel: 'Generate videos',
    },
  };
  return configurations[kind];
}

function requestGenerationConfirmation(kind) {
  const details = getGenerationPreflight(kind);
  if (!details) return Promise.resolve(false);
  els.generationConfirmTitle.textContent = details.title;
  els.generationConfirmIntro.textContent = details.intro;
  els.generationConfirmScope.textContent = details.scope;
  els.generationConfirmPrevious.textContent = details.previous;
  els.generationConfirmImpact.textContent = details.impact;
  els.generationConfirmRunBtn.textContent = details.confirmLabel;
  els.generationConfirmModal.returnValue = '';
  els.generationConfirmModal.showModal();
  return new Promise((resolve) => { generationConfirmResolve = resolve; });
}

function refreshSceneCountSuggestion({ apply = false } = {}) {
  const suggested = suggestSceneCount(els.scriptText.value);
  const isAuto = els.sceneCount.dataset.mode !== 'manual';
  els.autoSceneCountBtn.querySelector('.action-label').textContent = 'Auto';
  els.autoSceneCountBtn.title = `Automatically use the recommended scene count (${suggested})`;
  els.autoSceneCountBtn.classList.toggle('is-active', isAuto);
  els.autoSceneCountBtn.setAttribute('aria-pressed', String(isAuto));
  if (apply && isAuto) els.sceneCount.value = suggested;
}

async function refreshVoicesForCurrentProvider() {
  const provider = voiceStore.get().audioProvider;
  if (provider === 'elevenlabs') await loadElevenLabsVoices(setStatus);
  if (provider === 'spark') await loadSparkVoices(setStatus);
}

async function loadStoryboardIntoUI() {
  await loadStyles(els);
  await loadStyleReferences(els.styleSelect.value, els, setStatus);
  await refreshVoicesForCurrentProvider();
  renderVoicesPanel(els);
  updateButtons(els);
}

function attachEvents() {
  const settingsModalPairs = [
    [els.commonPromptSettingsBtn, els.commonPromptModal],
    [els.styleReferencesSettingsBtn, els.styleReferencesModal],
    [els.audioSettingsBtn, els.audioSettingsModal],
  ];
  settingsModalPairs.forEach(([trigger, modal]) => {
    trigger.addEventListener('click', () => modal.showModal());
    modal.querySelectorAll('[data-close-settings]').forEach((button) => {
      button.addEventListener('click', () => modal.close());
    });
    modal.addEventListener('click', (event) => {
      if (event.target === modal) modal.close();
    });
  });

  els.generationConfirmCancelBtn.addEventListener('click', () => els.generationConfirmModal.close());
  els.generationConfirmCloseBtn.addEventListener('click', () => els.generationConfirmModal.close());
  els.generationConfirmRunBtn.addEventListener('click', () => els.generationConfirmModal.close('confirm'));
  els.generationConfirmModal.addEventListener('click', (event) => {
    if (event.target === els.generationConfirmModal) els.generationConfirmModal.close();
  });
  els.generationConfirmModal.addEventListener('close', () => {
    const resolve = generationConfirmResolve;
    generationConfirmResolve = null;
    if (resolve) resolve(els.generationConfirmModal.returnValue === 'confirm');
  });

  els.newStoryboardBtn.addEventListener('click', async () => {
    createStoryboard(els);
    refreshSceneCountSuggestion({ apply: true });
    renderStoryboardPicker(els);
    saveStoryboard(els, true);
    await loadStoryboardIntoUI();
  });

  els.storyboardPicker.addEventListener('change', async (e) => {
    await openStoryboard(e.target.value, els);
    refreshSceneCountSuggestion({ apply: true });
    renderStoryboardPicker(els);
    await loadStoryboardIntoUI();
  });

  els.storyboardTitle.addEventListener('input', () => {
    saveStoryboard(els, false);
    const selectedOption = els.storyboardPicker.selectedOptions[0];
    if (selectedOption) selectedOption.textContent = getCurrentStoryboardRecord().title;
  });
  els.storyboardTitle.addEventListener('blur', () => {
    els.storyboardTitle.value = getCurrentStoryboardRecord().title;
  });
  els.storyboardTitle.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') els.storyboardTitle.blur();
  });

  els.saveStateBtn.addEventListener('click', () => saveStoryboard(els, true));

  els.resizeSceneList?.addEventListener('click', (event) => {
    const button = event.target.closest('.resize-scenes');
    if (!button || !els.resizeSceneList.contains(button)) return;

    const columns = Number(button.dataset.columns);
    if (!Number.isInteger(columns) || columns < 1 || columns > 6) return;

    els.storyboardGrid.style.setProperty('--scene-columns', columns);
    els.storyboardGrid.dataset.columns = String(columns);
    els.resizeSceneList.querySelectorAll('.resize-scenes').forEach((candidate) => {
      const isActive = candidate === button;
      candidate.classList.toggle('is-active', isActive);
      candidate.setAttribute('aria-pressed', String(isActive));
    });
  });

  els.scriptText.addEventListener('input', () => {
    refreshSceneCountSuggestion({ apply: true });
    saveStoryboard(els, false);
    updateButtons(els);
  });
  els.commonPromptText.addEventListener('input', () => { saveStoryboard(els, false); updateButtons(els); });
  els.sceneCount.addEventListener('input', () => {
    els.sceneCount.dataset.mode = 'manual';
    refreshSceneCountSuggestion();
    saveStoryboard(els, false);
  });
  els.autoSceneCountBtn.addEventListener('click', () => {
    els.sceneCount.dataset.mode = 'auto';
    refreshSceneCountSuggestion({ apply: true });
    saveStoryboard(els, false);
  });
  [els.textProvider, els.imageProvider].forEach((el) => {
    el.addEventListener('change', () => saveStoryboard(els, false));
  });
  els.videoMotionIntensity.addEventListener('change', () => saveStoryboard(els, false));

  const isGenerationActionLocked = (button) => {
    if (button.dataset.locked !== 'true') return false;
    setStatus(button.dataset.prerequisite || 'Complete the required earlier stage first.');
    return true;
  };

  els.generatePromptsBtn.addEventListener('click', async () => {
    if (!isGenerationActionLocked(els.generatePromptsBtn) && await requestGenerationConfirmation('prompts')) {
      generatePrompts(els, setStatus);
    }
  });
  els.generateDialogueBtn.addEventListener('click', async () => {
    if (!isGenerationActionLocked(els.generateDialogueBtn) && await requestGenerationConfirmation('dialogue')) {
      generateDialogue(els, setStatus);
    }
  });
  els.downloadZipBtn.addEventListener('click', () => downloadZip(setStatus));

  els.startSerialBtn.addEventListener('click', async () => {
    if (isGenerationActionLocked(els.startSerialBtn)) return;
    const current = batchStore.get().images;
    if (current?.generating) batchController.stop('images', projectStore.get().currentId);
    else if (await requestGenerationConfirmation('images')) {
      setStatus('Starting serial image generation...');
      await batchController.start('images', (i, scene) => regenerateImage(i, scene, els, setStatus, true), () => sceneStore.get().scenes);
    }
  });

  els.startAudioSerialBtn.addEventListener('click', async () => {
    if (isGenerationActionLocked(els.startAudioSerialBtn)) return;
    const current = batchStore.get().audio;
    if (current?.generating) batchController.stop('audio', projectStore.get().currentId);
    else if (await requestGenerationConfirmation('audio')) {
      setStatus('Starting serial audio generation...');
      await batchController.start('audio', (i, scene) => regenerateAudio(i, scene, els, setStatus, true), () => sceneStore.get().scenes);
    }
  });

  els.startVideoSerialBtn.addEventListener('click', async () => {
    if (isGenerationActionLocked(els.startVideoSerialBtn)) return;
    const current = batchStore.get().videos;
    if (current?.generating) batchController.stop('videos', projectStore.get().currentId);
    else if (await requestGenerationConfirmation('videos')) {
      setStatus('Starting serial video generation...');
      await batchController.start('videos', (i, scene) => regenerateVideo(i, scene, els, setStatus, true), () => sceneStore.get().scenes);
    }
  });

  els.styleSelect.addEventListener('change', async () => {
    const styleId = els.styleSelect.value;
    prefillCommonPrompt(styleId, els);
    saveStoryboard(els, false);
    updateButtons(els);
    await loadStyleReferences(styleId, els, setStatus);
  });
  els.styleReferencesSettingsBtn.addEventListener('click', () => loadStyleReferences(els.styleSelect.value, els, setStatus));
  els.characterRefInput.addEventListener('change', (e) => uploadStyleReferences('characters', e.target.files, els, setStatus));
  els.worldRefInput.addEventListener('change', (e) => uploadStyleReferences('world', e.target.files, els, setStatus));

  els.audioProvider.addEventListener('change', async (e) => {
    voiceStore.set({ audioProvider: e.target.value });
    await refreshVoicesForCurrentProvider();
    renderVoicesPanel(els);
    saveStoryboard(els, false);
  });

  els.voiceCloningBtn.addEventListener('click', () => openVoiceLibraryModal(els, setStatus));
  els.closeVoiceLibraryBtn.addEventListener('click', () => els.voiceLibraryModal.close());
  els.voiceLibraryModal.addEventListener('click', (event) => {
    if (event.target === els.voiceLibraryModal) els.voiceLibraryModal.close();
  });
  els.voiceLibraryModal.addEventListener('close', () => closeVoiceLibraryCleanup(els));
  els.voiceMicSelect.addEventListener('change', () => switchMicrophone(els.voiceMicSelect.value, els));
  els.voiceRecordBtn.addEventListener('click', () => toggleVoiceRecording(els));
  els.voiceSaveBtn.addEventListener('click', async () => {
    const blob = voiceRecordingState.recordedBlob;
    if (!blob) return;
    const name = els.voiceNameInput.value.trim();
    if (!name) {
      setStatus('Enter a name for this voice before saving.');
      return;
    }
    els.voiceSaveBtn.disabled = true;
    const ok = await cloneVoice(blob, name, setStatus);
    if (ok) {
      resetVoiceRecordingUI(els);
      renderVoiceLibraryList(els, setStatus);
      renderVoicesPanel(els);
    } else {
      els.voiceSaveBtn.disabled = false;
    }
  });

  // Watchers for basic UI updates
  sceneStore.subscribe(() => updateButtons(els));
  uiStore.subscribe(() => updateButtons(els));
  batchStore.subscribe(() => updateButtons(els));
}

async function init() {
  initRendering(els);
  initTimeline(els);
  attachEvents();

  await restoreStoryboardLibrary(els);
  refreshSceneCountSuggestion({ apply: true });
  renderStoryboardPicker(els);
  await loadStoryboardIntoUI();

  setStatus('Ready. Saved.');
}

init().catch(err => {
  console.error("Failed to init app:", err);
  setStatus("Failed to initialize app.");
});
