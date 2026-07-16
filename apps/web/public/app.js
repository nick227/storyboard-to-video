import { projectStore, sceneStore, voiceStore, uiStore, batchStore } from './modules/store.js';
import { restoreStoryboardLibrary, openStoryboard, createStoryboard, saveStoryboard } from './modules/persistence.js';
import { initRendering } from './modules/rendering.js';
import { initTimeline } from './modules/timeline.js';
import { renderStoryboardPicker, loadStyles, loadStyleReferences, uploadStyleReferences, prefillCommonPrompt, renderVoicesPanel, updateButtons } from './modules/ui.js';
import { generatePrompts, generateDialogue, downloadZip, regenerateImage, regenerateAudio, regenerateVideo } from './modules/workflows.js';
import { batchController } from './modules/batch.js';
import {
  loadElevenLabsVoices, loadSparkVoices, cloneVoice, switchMicrophone,
  openVoiceLibraryModal, closeVoiceLibraryCleanup, toggleVoiceRecording,
  renderVoiceLibraryList, resetVoiceRecordingUI, voiceRecordingState,
} from './modules/voices.js';

const els = {
  // Elements
  scriptText: document.getElementById('scriptText'),
  sceneCount: document.getElementById('sceneCount'),
  styleSelect: document.getElementById('styleSelect'),
  commonPromptText: document.getElementById('commonPromptText'),
  textProvider: document.getElementById('textProvider'),
  imageProvider: document.getElementById('imageProvider'),
  audioProvider: document.getElementById('audioProvider'),
  videoMotionIntensity: document.getElementById('videoMotionIntensity'),
  fallbackPolicy: document.getElementById('fallbackPolicy'),
  statusText: document.getElementById('statusText'),
  storyboardGrid: document.getElementById('storyboardGrid'),
  sceneCardTemplate: document.getElementById('sceneCardTemplate'),
  
  // Navigation / Actions
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
  
  // References
  styleReferencesDetails: document.getElementById('styleReferencesDetails'),
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
  
  // Timeline
  timelineSection: document.getElementById('timelineSection'),
  timelineVideo: document.getElementById('timelineVideo'),
  timelineImage: document.getElementById('timelineImage'),
  timelineStageEmpty: document.getElementById('timelineStageEmpty'),
  timelineAudio: document.getElementById('timelineAudio'),
  timelineToggle: document.getElementById('timelineToggle'),
  timelineScrubber: document.getElementById('timelineScrubber'),
  timelineTime: document.getElementById('timelineTime'),
  timelineTrackWrap: document.getElementById('timelineTrackWrap'),
  timelineTrackInner: document.getElementById('timelineTrackInner'),
  timelineThumbs: document.getElementById('timelineThumbs'),
  timelineWaveformCanvas: document.getElementById('timelineWaveformCanvas'),
  timelinePlayhead: document.getElementById('timelinePlayhead'),
};

function setStatus(msg) {
  if (els.statusText) els.statusText.textContent = msg;
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
  els.newStoryboardBtn.addEventListener('click', async () => {
    createStoryboard(els);
    renderStoryboardPicker(els);
    saveStoryboard(els, true);
    await loadStoryboardIntoUI();
  });

  els.storyboardPicker.addEventListener('change', async (e) => {
    await openStoryboard(e.target.value, els);
    await loadStoryboardIntoUI();
  });

  els.saveStateBtn.addEventListener('click', () => saveStoryboard(els, true));

  [els.scriptText, els.commonPromptText].forEach((el) => {
    el.addEventListener('input', () => { saveStoryboard(els, false); updateButtons(els); });
  });
  els.sceneCount.addEventListener('input', () => saveStoryboard(els, false));
  [els.textProvider, els.imageProvider].forEach((el) => {
    el.addEventListener('change', () => saveStoryboard(els, false));
  });
  els.videoMotionIntensity.addEventListener('change', () => saveStoryboard(els, false));

  els.generatePromptsBtn.addEventListener('click', () => generatePrompts(els, setStatus));
  els.generateDialogueBtn.addEventListener('click', () => generateDialogue(els, setStatus));
  els.downloadZipBtn.addEventListener('click', () => downloadZip(setStatus));

  els.startSerialBtn.addEventListener('click', async () => {
    const current = batchStore.get().images;
    if (current?.generating) batchController.stop('images', projectStore.get().currentId);
    else if (['paused', 'failed'].includes(current?.state)) {
      setStatus('Resuming image generation...');
      await batchController.resume('images', (i, scene) => regenerateImage(i, scene, els, setStatus, true), () => sceneStore.get().scenes);
    } else {
      setStatus('Starting serial image generation...');
      await batchController.start('images', (i, scene) => regenerateImage(i, scene, els, setStatus, true), () => sceneStore.get().scenes);
    }
  });

  els.startAudioSerialBtn.addEventListener('click', async () => {
    const current = batchStore.get().audio;
    if (current?.generating) batchController.stop('audio', projectStore.get().currentId);
    else if (['paused', 'failed'].includes(current?.state)) {
      setStatus('Resuming audio generation...');
      await batchController.resume('audio', (i, scene) => regenerateAudio(i, scene, els, setStatus, true), () => sceneStore.get().scenes);
    } else {
      setStatus('Starting serial audio generation...');
      await batchController.start('audio', (i, scene) => regenerateAudio(i, scene, els, setStatus, true), () => sceneStore.get().scenes);
    }
  });

  els.startVideoSerialBtn.addEventListener('click', async () => {
    const current = batchStore.get().videos;
    if (current?.generating) batchController.stop('videos', projectStore.get().currentId);
    else if (['paused', 'failed'].includes(current?.state)) {
      setStatus('Resuming video generation...');
      await batchController.resume('videos', (i, scene) => regenerateVideo(i, scene, els, setStatus, true), () => sceneStore.get().scenes);
    } else {
      setStatus('Starting serial video generation...');
      await batchController.start('videos', (i, scene) => regenerateVideo(i, scene, els, setStatus, true), () => sceneStore.get().scenes);
    }
  });

  els.styleSelect.addEventListener('change', () => {
    if (!els.commonPromptText.value.trim()) prefillCommonPrompt(els.styleSelect.value, els);
    loadStyleReferences(els.styleSelect.value, els, setStatus);
    saveStoryboard(els, false);
    updateButtons(els);
  });
  els.styleReferencesDetails.addEventListener('toggle', () => loadStyleReferences(els.styleSelect.value, els, setStatus));
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
  renderStoryboardPicker(els);
  await loadStoryboardIntoUI();

  setStatus('Ready. Changes save automatically.');
}

init().catch(err => {
  console.error("Failed to init app:", err);
  setStatus("Failed to initialize app.");
});
