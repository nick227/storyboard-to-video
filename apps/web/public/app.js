import { projectStore, sceneStore, voiceStore, uiStore, batchStore } from './modules/store.js';
import { restoreStoryboardLibrary, openStoryboard, createStoryboard, saveStoryboard, getCurrentStoryboardRecord, setPersistenceScope } from './modules/persistence.js';
import { initRendering } from './modules/rendering.js';
import { initTimeline } from './modules/timeline.js';
import { renderStoryboardPicker, loadStyles, loadStyleReferences, uploadStyleReferences, prefillCommonPrompt, renderVoicesPanel, renderStageBar, initImageLibraryModal } from './modules/ui.js';
import { downloadZip } from './modules/workflows.js';
import { suggestSceneCount, suggestSceneCountFromNarration } from './modules/scene-count.js';
import { initializeAuth } from './modules/auth.js';
import {
  refreshRecentJobs, getCachedJobs, getStageSelection, toggleStageSelection,
  replanStory, regenerateAllStage, stopActiveWork, runCreateStoryFlow,
  computeRunRange, buildRunRowStatus, computeForceStages,
} from './modules/stages.js';
import {
  loadElevenLabsVoices, loadSparkVoices, loadPiperVoices, cloneVoice, switchMicrophone,
  openVoiceLibraryModal, closeVoiceLibraryCleanup, toggleVoiceRecording,
  renderVoiceLibraryList, resetVoiceRecordingUI, voiceRecordingState,
} from './modules/voices.js';

const els = {
  // Elements
  scriptText: document.getElementById('scriptText'),

  styleSelect: document.getElementById('styleSelect'),
  commonPromptText: document.getElementById('commonPromptText'),
  textProvider: document.getElementById('textProvider'),
  imageProvider: document.getElementById('imageProvider'),
  audioProvider: document.getElementById('audioProvider'),
  videoMotionIntensity: document.getElementById('videoMotionIntensity'),
  fallbackPolicy: document.getElementById('fallbackPolicy'),
  enrichNarration: document.getElementById('enrichNarration'),
  statusText: document.getElementById('statusText'),
  generationSummaryText: document.getElementById('generationSummaryText'),
  storyboardSection: document.getElementById('storyboardSection'),
  storyboardGrid: document.getElementById('storyboardGrid'),
  resizeSceneList: document.querySelector('.resize-scene-list'),
  sceneCardTemplate: document.getElementById('sceneCardTemplate'),
  characterRefLibraryBtn: document.getElementById('characterRefLibraryBtn'),
  worldRefLibraryBtn: document.getElementById('worldRefLibraryBtn'),
  
  // Navigation / Actions
  storyboardTitle: document.getElementById('storyboardTitle'),
  storyboardPickerToggle: document.getElementById('storyboardPickerToggle'),
  storyboardPickerList: document.getElementById('storyboardPickerList'),
  newStoryboardBtn: document.getElementById('newStoryboardBtn'),
  saveStateBtn: document.getElementById('saveStateBtn'),
  downloadZipBtn: document.getElementById('downloadZipBtn'),
  authLoggedIn: document.getElementById('authLoggedIn'),
  adminConsoleLink: document.getElementById('adminConsoleLink'),
  authUserAvatar: document.getElementById('authUserAvatar'),
  authUserLabel: document.getElementById('authUserLabel'),
  logoutBtn: document.getElementById('logoutBtn'),
  
  // Stage bar
  stagePlanningBtn: document.getElementById('stagePlanningBtn'),
  stagePlanningStatus: document.getElementById('stagePlanningStatus'),
  stageImagesBtn: document.getElementById('stageImagesBtn'),
  stageImagesStatus: document.getElementById('stageImagesStatus'),
  stageAudioBtn: document.getElementById('stageAudioBtn'),
  stageAudioStatus: document.getElementById('stageAudioStatus'),
  stageVideoBtn: document.getElementById('stageVideoBtn'),
  stageVideoStatus: document.getElementById('stageVideoStatus'),
  startPauseBtn: document.getElementById('startPauseBtn'),

  // Settings modal: visual planning mode, scene-count recommendation policy, danger zone
  planningModeSelect: document.getElementById('planningModeSelect'),
  settingsSceneCountInput: document.getElementById('settingsSceneCountInput'),
  settingsSceneCountAutoCheckbox: document.getElementById('settingsSceneCountAutoCheckbox'),
  settingsSceneCountAutoBtn: document.getElementById('settingsSceneCountAutoBtn'),
  settingsReplanBtn: document.getElementById('settingsReplanBtn'),
  settingsRegenerateImagesBtn: document.getElementById('settingsRegenerateImagesBtn'),
  settingsRegenerateAudioBtn: document.getElementById('settingsRegenerateAudioBtn'),
  settingsRegenerateVideoBtn: document.getElementById('settingsRegenerateVideoBtn'),

  // Settings modals
  settingsBtn: document.getElementById('settingsBtn'),
  settingsModal: document.getElementById('settingsModal'),
  styleReferencesPanel: document.getElementById('styleReferencesPanel'),
  sceneReferencesModal: document.getElementById('sceneReferencesModal'),
  sceneReferencesModalSceneLabel: document.getElementById('sceneReferencesModalSceneLabel'),
  sceneDefaultReferences: document.getElementById('sceneDefaultReferences'),
  sceneUploadedReferences: document.getElementById('sceneUploadedReferences'),
  sceneReferenceInput: document.getElementById('sceneReferenceInput'),
  sceneReferencesSaveNote: document.getElementById('sceneReferencesSaveNote'),

  // Generation preflight
  generationConfirmModal: document.getElementById('generationConfirmModal'),
  generationConfirmTitle: document.getElementById('generationConfirmTitle'),
  generationConfirmIntro: document.getElementById('generationConfirmIntro'),
  generationConfirmBullets: document.getElementById('generationConfirmBullets'),
  generationConfirmCloseBtn: document.getElementById('generationConfirmCloseBtn'),
  generationConfirmCancelBtn: document.getElementById('generationConfirmCancelBtn'),
  generationConfirmRunBtn: document.getElementById('generationConfirmRunBtn'),

  // Start modal — the primary run-control surface (scene range + Planning/Images/Audio/Video rows)
  startRunModal: document.getElementById('startRunModal'),
  startRunSceneLabel: document.getElementById('startRunSceneLabel'),
  startRunSceneTotal: document.getElementById('startRunSceneTotal'),
  startRunRangeAll: document.getElementById('startRunRangeAll'),
  startRunRangeNext: document.getElementById('startRunRangeNext'),
  startRunNextCount: document.getElementById('startRunNextCount'),
  startRunRows: document.getElementById('startRunRows'),
  startRunWarning: document.getElementById('startRunWarning'),
  startRunCloseBtn: document.getElementById('startRunCloseBtn'),
  startRunCancelBtn: document.getElementById('startRunCancelBtn'),
  startRunConfirmBtn: document.getElementById('startRunConfirmBtn'),
  startRunPlanningCheck: document.getElementById('startRunPlanningCheck'),
  startRunPlanningStatus: document.getElementById('startRunPlanningStatus'),
  startRunImagesCheck: document.getElementById('startRunImagesCheck'),
  startRunImagesStatus: document.getElementById('startRunImagesStatus'),
  startRunAudioCheck: document.getElementById('startRunAudioCheck'),
  startRunAudioStatus: document.getElementById('startRunAudioStatus'),
  startRunVideoCheck: document.getElementById('startRunVideoCheck'),
  startRunVideoStatus: document.getElementById('startRunVideoStatus'),

  // References
  characterRefs: document.getElementById('characterRefs'),
  worldRefs: document.getElementById('worldRefs'),
  characterRefInput: document.getElementById('characterRefInput'),
  worldRefInput: document.getElementById('worldRefInput'),
  

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
  entityModalInstructionField: document.getElementById('entityModalInstructionField'),
  entityModalInstruction: document.getElementById('entityModalInstruction'),
  entityModalStaleWarning: document.getElementById('entityModalStaleWarning'),
  entityModalFallbackWarning: document.getElementById('entityModalFallbackWarning'),
  entityModalExpandSection: document.getElementById('entityModalExpandSection'),
  entityModalExpandText: document.getElementById('entityModalExpandText'),
  entityModalExpandBtn: document.getElementById('entityModalExpandBtn'),
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
  timelineTrackWrap: document.getElementById('timelineTrackWrap'),
  timelineTrackInner: document.getElementById('timelineTrackInner'),
  timelineThumbs: document.getElementById('timelineThumbs'),
  timelineWaveformCanvas: document.getElementById('timelineWaveformCanvas'),
  timelinePlayhead: document.getElementById('timelinePlayhead'),
};

let generationConfirmResolve = null;

function setStatus(msg) {
  if (els.statusText) els.statusText.textContent = msg;
}

// Runs one startup/reload stage in isolation so a failure in one loader (e.g. a
// missing DOM binding or a stale project 404) can't take down unrelated ones.
async function runStage(label, fn) {
  try {
    await fn();
    return true;
  } catch (error) {
    console.error(`${label} failed:`, error);
    setStatus(`${label} failed: ${error.message}`);
    return false;
  }
}

function selectedLabel(select) {
  return select.selectedOptions?.[0]?.textContent?.trim() || select.value;
}

// Only three purposes remain for this confirm modal now that Planning has its own dedicated
// revision-aware UI: the explicit, harder-to-reach "Regenerate all" action per media stage (spend-
// relevant, so it's never a bare single click), and the "Replan story structure" destructive
// rebuild (including when it's really a scene-count reduction, which is the same rebuild, not a
// quiet trim — the copy below names that consequence directly rather than hiding it behind "Replan").
function getGenerationPreflight(kind, context = {}) {
  const scenes = sceneStore.get().scenes;
  const total = scenes.length;
  const versionStats = (key) => ({
    scenes: scenes.filter((scene) => (scene[key] || []).some((version) => version?.path)).length,
    versions: scenes.reduce((sum, scene) => sum + (scene[key] || []).filter((version) => version?.path).length, 0),
  });

  // Each kind returns { title, paragraph, bullets, confirmLabel } — one plain-statement title (never
  // a question), one sentence of essential context, then bullets for specifics. No boilerplate.
  const mediaConfig = (label, versionsKey, providerSelect, extra = '') => {
    const stats = versionStats(versionsKey);
    const bullets = [`${total} scenes · ${selectedLabel(providerSelect)}${extra}`];
    if (stats.versions) bullets.push(`${stats.scenes}/${total} scenes already have a version — those are replaced too`);
    bullets.push(`Prefer "Generate missing/stale" unless you want to redo everything`);
    return {
      title: `Regenerate all ${label.toLowerCase()}`,
      paragraph: `This replaces every scene's ${label.toLowerCase()}, including ones already up to date.`,
      bullets,
      confirmLabel: `Regenerate all ${label.toLowerCase()}`,
    };
  };

  const configurations = {
    imagesAll: mediaConfig('Images', 'versions', els.imageProvider, ' with the selected style and references'),
    audioAll: mediaConfig('Audio', 'audioVersions', els.audioProvider, ' and the selected narrator voice'),
    videoAll: mediaConfig('Video', 'videoVersions', els.videoMotionIntensity, ' motion intensity'),
    planningReplan: (() => {
      const shrinking = context.fromCount != null && context.toCount != null && context.fromCount !== context.toCount;
      return {
        title: shrinking ? `Reduce to ${context.toCount} scenes` : 'Replan story structure',
        paragraph: shrinking
          ? `Reducing from ${context.fromCount} to ${context.toCount} scenes will rebuild the storyboard structure and retire media.`
          : 'This re-segments the story from the original script, discarding the current scene structure.',
        bullets: [
          `${context.toCount ?? total} scenes, rebuilt from the original script`,
          `Prompts, images, audio, and video tied to replaced scenes are retired, not orphaned`,
        ],
        confirmLabel: 'Replan story structure',
      };
    })(),
    // Planning owns the final scene count before prompts/images/audio/video lock in — this is the
    // one point where a narration-derived recommendation (which only ever grows, never shrinks; see
    // suggestSceneCountFromNarration) gets reconciled against what was actually requested, instead of
    // silently overriding or silently ignoring it.
    sceneCountReconcile: (() => {
      const scenes = (n) => `${n} scene${n === 1 ? '' : 's'}`;
      return {
        title: 'Narration suggests more scenes',
        paragraph: `You planned ${scenes(context.currentCount)}, but the generated narration comfortably fills ${context.recommended}. Splitting keeps each scene's visuals, audio, and video in sync with how much narration it actually carries.`,
        bullets: [
          `${scenes(context.currentCount)} planned`,
          `${scenes(context.recommended)} recommended from narration pacing`,
          `Existing prompts/images/audio for current scenes are kept, not discarded`,
        ],
        cancelLabel: `Keep ${context.currentCount}`,
        confirmLabel: `Use ${context.recommended}`,
      };
    })(),
  };
  return configurations[kind];
}

// --- Start modal: the primary run-control surface ----------------------------
//
// Replaces the old startRun bullet-list confirmation. This modal is genuinely interactive (the
// range picker and checkboxes change each other's defaults live), unlike the static
// getGenerationPreflight confirmations above, so it's driven directly rather than forced through
// that shape.

const STAGE_ROW_ELS = () => ({
  planning: { check: els.startRunPlanningCheck, status: els.startRunPlanningStatus },
  images: { check: els.startRunImagesCheck, status: els.startRunImagesStatus },
  audio: { check: els.startRunAudioCheck, status: els.startRunAudioStatus },
  video: { check: els.startRunVideoCheck, status: els.startRunVideoStatus },
});

function formatStartRunRowStatus(stage, row) {
  if (stage === 'planning') {
    const p = row.full;
    // Mirrors runCreateStoryFlow's own planning branching exactly, so the row never promises
    // something the run won't actually do.
    if (!p.total || p.missing > 0 || p.hasChanges) return 'Creates the full storyboard structure — not limited to the selected range.';
    if (p.stale > 0) return `Updates ${p.stale} stale prompt${p.stale === 1 ? '' : 's'} in the selected range.`;
    return `${p.label} — up to date.`;
  }
  return `${row.ranged.label} selected · ${row.full.label} total`;
}

let startRunResolve = null;

// One computation, reused by both the render pass and the confirm handler, so what the user sees
// is exactly what the run acts on.
function computeStartRunPlan() {
  const scenes = sceneStore.get().scenes;
  const record = getCurrentStoryboardRecord();
  const mode = els.startRunRangeNext.checked ? 'next' : 'all';
  const count = Number(els.startRunNextCount.value) || 1;
  const range = computeRunRange(scenes, uiStore.get().selectedSceneId, mode, count);
  const rowStatus = buildRunRowStatus(scenes, range, batchStore.get(), uiStore.get().operation, getCachedJobs(), record?.stageRuns || {});
  const selectionStatus = { planning: rowStatus.planning.ranged, images: rowStatus.images.ranged, audio: rowStatus.audio.ranged, video: rowStatus.video.ranged };
  return { scenes, range, rowStatus, selectionStatus };
}

function renderStartRunModal() {
  const { scenes, range, rowStatus, selectionStatus } = computeStartRunPlan();
  const selection = getStageSelection(selectionStatus);

  els.startRunSceneLabel.textContent = String(Math.min(range.startIndex + 1, Math.max(scenes.length, 1)));
  els.startRunSceneTotal.textContent = String(scenes.length);

  const rowEls = STAGE_ROW_ELS();
  for (const stage of ['planning', 'images', 'audio', 'video']) {
    const { check, status } = rowEls[stage];
    check.checked = Boolean(selection[stage]);
    status.textContent = formatStartRunRowStatus(stage, rowStatus[stage]);
  }
  return { range, rowStatus, selectionStatus };
}

function openStartRunModal() {
  if (!sceneStore.get().scenes.length) {
    // Nothing to anchor a range to yet — Planning creates the first scenes. Default the range
    // radios back to "All remaining" so a later open (once scenes exist) isn't left on a
    // meaningless "next N of zero".
    els.startRunRangeAll.checked = true;
  }
  renderStartRunModal();
  els.startRunModal.returnValue = '';
  els.startRunModal.showModal();
  return new Promise((resolve) => { startRunResolve = resolve; });
}

function requestGenerationConfirmation(kind, context = {}) {
  const details = getGenerationPreflight(kind, context);
  if (!details) return Promise.resolve(false);
  els.generationConfirmTitle.textContent = details.title;
  els.generationConfirmIntro.textContent = details.paragraph;
  els.generationConfirmBullets.replaceChildren(...details.bullets.map((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    return li;
  }));
  els.generationConfirmRunBtn.textContent = details.confirmLabel;
  els.generationConfirmCancelBtn.textContent = details.cancelLabel || 'Cancel';
  els.generationConfirmModal.returnValue = '';
  els.generationConfirmModal.showModal();
  return new Promise((resolve) => { generationConfirmResolve = resolve; });
}



function getSceneCountEstimate() {
  const scenes = sceneStore.get().scenes;
  if (scenes && scenes.length > 0) {
    const recommended = suggestSceneCountFromNarration(scenes);
    if (recommended > 0) return recommended;
  }
  const scriptText = String(els.scriptText?.value || '').trim();
  if (scriptText) {
    const scriptEstimate = suggestSceneCount(scriptText);
    if (scriptEstimate > 0) return scriptEstimate;
  }
  return null;
}

function refreshSceneCountPolicy() {
  if (!els.settingsSceneCountInput || !els.settingsSceneCountAutoCheckbox || !els.settingsSceneCountAutoBtn) return;
  const estimate = getSceneCountEstimate();
  
  if (els.settingsSceneCountAutoCheckbox.checked) {
    els.settingsSceneCountInput.disabled = true;
    els.settingsSceneCountAutoBtn.disabled = true;
  } else {
    els.settingsSceneCountInput.disabled = false;
    
    if (estimate && estimate > 0) {
      els.settingsSceneCountAutoBtn.disabled = false;
      if (!els.settingsSceneCountInput.value || Number(els.settingsSceneCountInput.value) === 0) {
        els.settingsSceneCountInput.value = estimate;
      }
    } else {
      els.settingsSceneCountAutoBtn.disabled = true;
    }
  }
}

async function refreshVoicesForCurrentProvider() {
  const provider = voiceStore.get().audioProvider;
  if (provider === 'elevenlabs') await loadElevenLabsVoices(setStatus);
  if (provider === 'spark') await loadSparkVoices(setStatus);
  if (provider === 'piper') await loadPiperVoices(setStatus);
}

async function loadStoryboardIntoUI() {
  const stylesLoaded = await runStage('Loading styles', () => loadStyles(els));
  const referencesLoaded = await runStage('Loading style references', () => loadStyleReferences(els.styleSelect.value, els, setStatus));
  const voicesLoaded = await runStage('Loading voices', () => refreshVoicesForCurrentProvider());
  await runStage('Loading job history', () => refreshRecentJobs(projectStore.get().currentId));
  renderVoicesPanel(els);
  renderStageBar(els);
  refreshSceneCountPolicy();
  return stylesLoaded && referencesLoaded && voicesLoaded;
}

function attachEvents() {
  const settingsModalPairs = [
    [els.settingsBtn, els.settingsModal],
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

  els.startRunCancelBtn.addEventListener('click', () => els.startRunModal.close());
  els.startRunCloseBtn.addEventListener('click', () => els.startRunModal.close());
  els.startRunConfirmBtn.addEventListener('click', () => els.startRunModal.close('confirm'));
  els.startRunModal.addEventListener('click', (event) => {
    if (event.target === els.startRunModal) els.startRunModal.close();
  });
  els.startRunModal.addEventListener('close', () => {
    const resolve = startRunResolve;
    startRunResolve = null;
    if (resolve) resolve(els.startRunModal.returnValue === 'confirm');
  });
  [els.startRunRangeAll, els.startRunRangeNext, els.startRunNextCount].forEach((input) => {
    input.addEventListener('input', () => renderStartRunModal());
  });
  [els.startRunPlanningCheck, els.startRunImagesCheck, els.startRunAudioCheck, els.startRunVideoCheck].forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      // The click already flipped checkbox.checked — toggleStageSelection just needs to record
      // that override against the range-scoped status so it survives a later re-render (e.g. the
      // user then adjusts the range picker).
      const { selectionStatus } = computeStartRunPlan();
      toggleStageSelection(checkbox.dataset.stage, selectionStatus);
      renderStartRunModal();
    });
  });

  els.newStoryboardBtn.addEventListener('click', async () => {
    createStoryboard(els);
    renderStoryboardPicker(els);
    saveStoryboard(els, true);
    await loadStoryboardIntoUI();
  });

  const closeStoryboardPicker = () => {
    els.storyboardPickerList.hidden = true;
    els.storyboardPickerToggle.setAttribute('aria-expanded', 'false');
  };
  const openStoryboardPicker = () => {
    els.storyboardPickerList.hidden = false;
    els.storyboardPickerToggle.setAttribute('aria-expanded', 'true');
  };

  els.storyboardPickerToggle.addEventListener('click', () => {
    if (els.storyboardPickerList.hidden) openStoryboardPicker();
    else closeStoryboardPicker();
  });

  els.storyboardPickerList.addEventListener('click', async (event) => {
    const item = event.target.closest('li[data-id]');
    if (!item) return;
    closeStoryboardPicker();
    if (item.dataset.id === getCurrentStoryboardRecord()?.id) return;
    await openStoryboard(item.dataset.id, els);
    renderStoryboardPicker(els);
    await loadStoryboardIntoUI();
  });

  document.addEventListener('click', (event) => {
    if (els.storyboardPickerList.hidden) return;
    if (event.target === els.storyboardPickerToggle || els.storyboardPickerList.contains(event.target)) return;
    closeStoryboardPicker();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !els.storyboardPickerList.hidden) closeStoryboardPicker();
  });

  els.storyboardTitle.addEventListener('input', () => {
    saveStoryboard(els, false);
    const current = getCurrentStoryboardRecord();
    const selectedItem = els.storyboardPickerList.querySelector('li[aria-selected="true"]');
    if (selectedItem) selectedItem.textContent = current.title;
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
    refreshSceneCountPolicy();
    saveStoryboard(els, false);
    renderStageBar(els);
  });
  els.commonPromptText.addEventListener('input', () => { saveStoryboard(els, false); renderStageBar(els); });
  [els.textProvider, els.imageProvider].forEach((el) => {
    el.addEventListener('change', () => saveStoryboard(els, false));
  });
  els.videoMotionIntensity.addEventListener('change', () => saveStoryboard(els, false));
  els.enrichNarration.addEventListener('change', () => saveStoryboard(els, false));

  els.downloadZipBtn.addEventListener('click', () => downloadZip(setStatus));

  // --- Settings: visual planning mode, scene-count policy, danger zone --------
  //
  // These replace the removed Planning modal and per-stage dialog. What used to be interactive
  // mid-run decisions are now pre-configured once in Settings (existing modal, existing pattern)
  // and read synchronously when Start needs them — no extra dialog appears mid-flow.

  const syncPlanningModeFromEnrich = () => {
    if (els.planningModeSelect) {
      els.planningModeSelect.value = els.enrichNarration.checked ? 'auto' : 'script';
    }
  };
  els.settingsBtn.addEventListener('click', () => {
    syncPlanningModeFromEnrich();
    refreshSceneCountPolicy();
  });

  if (els.planningModeSelect) {
    els.planningModeSelect.addEventListener('change', () => {
      els.enrichNarration.checked = els.planningModeSelect.value === 'auto';
      saveStoryboard(els, false);
    });
  }

  if (els.settingsSceneCountAutoCheckbox) {
    els.settingsSceneCountAutoCheckbox.addEventListener('change', () => {
      refreshSceneCountPolicy();
      saveStoryboard(els, false);
    });
  }
  if (els.settingsSceneCountInput) {
    els.settingsSceneCountInput.addEventListener('input', () => {
      saveStoryboard(els, false);
    });
  }
  if (els.settingsSceneCountAutoBtn) {
    els.settingsSceneCountAutoBtn.addEventListener('click', () => {
      const estimate = getSceneCountEstimate();
      if (estimate && estimate > 0) {
        els.settingsSceneCountInput.value = estimate;
        saveStoryboard(els, false);
      }
    });
  }

  // Called by runCreateStoryFlow only when Planning's narration-derived recommendation actually
  // differs from the requested scene count. "Auto" policy means the user already opted into always
  // following the recommendation, so it's applied silently. Otherwise this is planning's one point
  // to reconcile a manually-requested count against what the narration turned out to need — the
  // recommendation is never silently discarded and never silently applied, only offered.
  const onSceneCountDecision = async ({ recommended, currentCount }) => {
    if (els.settingsSceneCountAutoCheckbox && els.settingsSceneCountAutoCheckbox.checked) return recommended;
    const useRecommended = await requestGenerationConfirmation('sceneCountReconcile', { currentCount, recommended });
    return useRecommended ? recommended : currentCount;
  };

  els.settingsReplanBtn.addEventListener('click', async () => {
    if (!(await requestGenerationConfirmation('planningReplan', {}))) return;
    await replanStory(els, setStatus);
    await refreshRecentJobs(projectStore.get().currentId);
    renderStageBar(els);
  });
  const wireRegenerateAll = (button, stage, kind) => {
    button.addEventListener('click', async () => {
      if (!(await requestGenerationConfirmation(kind))) return;
      setStatus(`Regenerating all ${stage}...`);
      await regenerateAllStage(stage, els, setStatus);
      await refreshRecentJobs(projectStore.get().currentId);
      renderStageBar(els);
    });
  };
  wireRegenerateAll(els.settingsRegenerateImagesBtn, 'images', 'imagesAll');
  wireRegenerateAll(els.settingsRegenerateAudioBtn, 'audio', 'audioAll');
  wireRegenerateAll(els.settingsRegenerateVideoBtn, 'video', 'videoAll');

  // --- Start / Stop --------------------------------------------------------------
  //
  // A single toggle: idle -> opens the Start modal (scene range + Planning/Images/Audio/Video
  // rows, the only place selection happens now); running -> Stop, always resumable, no separate
  // harder-stop control. "Regenerate all" on an existing project is still Settings' job.

  els.startPauseBtn.addEventListener('click', async () => {
    if (els.startPauseBtn.dataset.running === 'true') {
      const result = stopActiveWork(projectStore.get().currentId);
      setStatus(result.kind === 'cancelled' ? 'Cancelling planning...' : result.kind === 'paused' ? 'Stopping...' : 'Nothing to stop.');
      renderStageBar(els);
      return;
    }
    if (uiStore.get().operation) return;

    const confirmed = await openStartRunModal();
    if (!confirmed) return;

    const { range, rowStatus, selectionStatus } = computeStartRunPlan();
    const selection = getStageSelection(selectionStatus);
    const stages = ['planning', 'images', 'audio', 'video'].filter((stage) => selection[stage]);
    if (!stages.length) { setStatus('Nothing selected to start — check a step above.'); return; }
    const forceStages = computeForceStages(rowStatus, selection);

    setStatus('Starting...');
    const result = await runCreateStoryFlow('custom', els, setStatus, { stages, range, forceStages, autoAcceptRecommendations: false, onSceneCountDecision });
    if (result.stoppedAt === 'needsReplanForShrink') setStatus('Stopped — the chosen scene count is smaller than the current structure; use Settings > Replan story structure explicitly to continue.');
    else if (result.stoppedAt) setStatus(`Stopped: ${result.stoppedAt}.`);
    else setStatus('Done.');
    await refreshRecentJobs(projectStore.get().currentId);
    renderStageBar(els);
  });

  els.styleSelect.addEventListener('change', async () => {
    const styleId = els.styleSelect.value;
    prefillCommonPrompt(styleId, els);
    saveStoryboard(els, false);
    renderStageBar(els);
    await loadStyleReferences(styleId, els, setStatus);
  });
  els.characterRefInput.addEventListener('change', (e) => uploadStyleReferences('characters', e.target.files, els, setStatus));
  els.worldRefInput.addEventListener('change', (e) => uploadStyleReferences('world', e.target.files, els, setStatus));

  els.audioProvider.addEventListener('change', async (e) => {
    voiceStore.set({ audioProvider: e.target.value });
    await refreshVoicesForCurrentProvider();
    renderVoicesPanel(els);
    saveStoryboard(els, false);
  });
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
  sceneStore.subscribe(() => renderStageBar(els));
  uiStore.subscribe(() => renderStageBar(els));
  batchStore.subscribe(() => renderStageBar(els));
}

async function init() {
  initRendering(els);
  initTimeline(els);
  initImageLibraryModal(els, setStatus);
  attachEvents();

  const session = await initializeAuth(els);
  if (!session) {
    setStatus('Log in to open your storyboards.');
    return;
  }
  setPersistenceScope(session.tenant.id);

  const restored = await runStage('Restoring your storyboards', () => restoreStoryboardLibrary(els));
  renderStoryboardPicker(els);
  const loaded = await loadStoryboardIntoUI();

  if (restored && loaded) setStatus('Ready. Saved.');
}

init().catch(err => {
  console.error("Failed to init app:", err);
  setStatus("Failed to initialize app.");
});
