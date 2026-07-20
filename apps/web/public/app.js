import { projectStore, sceneStore, voiceStore, uiStore, batchStore } from './modules/store.js';
import { restoreStoryboardLibrary, openStoryboard, createStoryboard, saveStoryboard, getCurrentStoryboardRecord, setPersistenceScope } from './modules/persistence.js';
import { initRendering, renderScenes } from './modules/rendering.js';
import { initTimeline } from './modules/timeline.js';
import { renderStoryboardPicker, loadStyles, loadStyleReferences, uploadStyleReferences, prefillCommonPrompt, renderVoicesPanel, renderStageBar, initImageLibraryModal, populateTokensInfoModal } from './modules/ui.js';
import { downloadZip } from './modules/workflows.js';
import { initializeAuth } from './modules/auth.js';
import {
  refreshRecentJobs, getCachedJobs, getStageSelection, toggleStageSelection,
  replanStory, regenerateAllStage, stopActiveWork, runCreateStoryFlow,
  computeRunRange, buildRunRowStatus, computeForceStages,
  refreshSpend, getCachedSpend,
} from './modules/stages.js';
import {
  loadElevenLabsVoices, loadSparkVoices, loadPiperVoices, refreshVoicesForCurrentProvider, cloneVoice, switchMicrophone,
  openVoiceLibraryModal, closeVoiceLibraryCleanup, toggleVoiceRecording,
  renderVoiceLibraryList, resetVoiceRecordingUI, voiceRecordingState,
} from './modules/voices.js';

import { ScreenplayEditor } from './modules/screenplay-editor/js/ScreenplayEditor.js';
import { toFinalDraftXml, toPlainScript, toPrintableScriptHtml, toRichTextScript, toStructuredScriptJson } from './modules/script-export.js';

const els = {
  // Elements
  scriptText: document.getElementById('scriptText'),
  scriptModeSelect: document.getElementById('scriptModeSelect'),
  screenplayEditorContainer: document.getElementById('screenplayEditorContainer'),
  scriptPagePanel: document.getElementById('scriptPagePanel'),
  scriptFocusBtn: document.getElementById('scriptFocusBtn'),
  scriptFocusBtnLabel: document.getElementById('scriptFocusBtnLabel'),
  scriptDownloadBtn: document.getElementById('scriptDownloadBtn'),
  scriptDownloadMenu: document.getElementById('scriptDownloadMenu'),

  // Studio page navigation
  pageTabs: document.querySelector('.page-tabs'),
  pageTabButtons: Array.from(document.querySelectorAll('.page-tab[data-page]')),
  pagePanels: Array.from(document.querySelectorAll('[role="tabpanel"]')),
  pageTransition: document.getElementById('pageTransition'),
  pageTransitionLabel: document.getElementById('pageTransitionLabel'),

  styleSelect: document.getElementById('styleSelect'),
  stageStyleSelect: document.getElementById('stageStyleSelect'),
  commonPromptText: document.getElementById('commonPromptText'),
  textProvider: document.getElementById('textProvider'),
  imageProvider: document.getElementById('imageProvider'),
  mediaAspectRatio: document.getElementById('mediaAspectRatio'),
  imageResolutionTier: document.getElementById('imageResolutionTier'),
  imageQuality: document.getElementById('imageQuality'),
  videoProvider: document.getElementById('videoProvider'),
  videoResolutionTier: document.getElementById('videoResolutionTier'),
  videoDurationSeconds: document.getElementById('videoDurationSeconds'),
  mediaCostPreview: document.getElementById('mediaCostPreview'),
  saveMediaDefaultsBtn: document.getElementById('saveMediaDefaultsBtn'),
  audioProvider: document.getElementById('audioProvider'),
  videoMotionIntensity: document.getElementById('videoMotionIntensity'),
  subtitleStyleSelect: document.getElementById('subtitleStyleSelect'),
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
  downloadConfirmModal: document.getElementById('downloadConfirmModal'),
  downloadConfirmCloseBtn: document.getElementById('downloadConfirmCloseBtn'),
  downloadConfirmCancelBtn: document.getElementById('downloadConfirmCancelBtn'),
  downloadConfirmRunBtn: document.getElementById('downloadConfirmRunBtn'),
  downloadConfirmWarning: document.getElementById('downloadConfirmWarning'),
  downloadConfirmBullets: document.getElementById('downloadConfirmBullets'),
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
  stageSubtitlesBtn: document.getElementById('stageSubtitlesBtn'),
  stageSubtitlesStatus: document.getElementById('stageSubtitlesStatus'),
  stageTokensBtn: document.getElementById('stageTokensBtn'),
  stageTokensStatus: document.getElementById('stageTokensStatus'),
  tokensInfoBtn: document.getElementById('tokensInfoBtn'),
  tokensInfoModal: document.getElementById('tokensInfoModal'),
  tokensInfoModalCloseBtn: document.getElementById('tokensInfoModalCloseBtn'),
  tokensInfoModalDoneBtn: document.getElementById('tokensInfoModalDoneBtn'),
  tokensSpendContainer: document.getElementById('tokensSpendContainer'),
  tokensPricingContainer: document.getElementById('tokensPricingContainer'),
  startPauseBtn: document.getElementById('startPauseBtn'),

  // Settings modal: visual planning mode, read-only shot count, danger zone
  planningModeSelect: document.getElementById('planningModeSelect'),
  settingsShotCountDisplay: document.getElementById('settingsShotCountDisplay'),
  settingsShotLimitSelect: document.getElementById('settingsShotLimitSelect'),
  settingsReplanBtn: document.getElementById('settingsReplanBtn'),
  settingsRegenerateImagesBtn: document.getElementById('settingsRegenerateImagesBtn'),
  settingsRegenerateAudioBtn: document.getElementById('settingsRegenerateAudioBtn'),
  settingsRegenerateVideoBtn: document.getElementById('settingsRegenerateVideoBtn'),
  settingsRegenerateSubtitlesBtn: document.getElementById('settingsRegenerateSubtitlesBtn'),

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
  startRunSubtitlesCheck: document.getElementById('startRunSubtitlesCheck'),
  startRunSubtitlesStatus: document.getElementById('startRunSubtitlesStatus'),

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
  confirmVideoKeyframes: document.getElementById('confirmVideoKeyframes'),
  confirmVideoKeyframesDetails: document.getElementById('confirmVideoKeyframesDetails'),
  confirmVideoStartFrame: document.getElementById('confirmVideoStartFrame'),
  confirmVideoEndFrame: document.getElementById('confirmVideoEndFrame'),
  confirmVideoStartPreview: document.getElementById('confirmVideoStartPreview'),
  confirmVideoEndPreview: document.getElementById('confirmVideoEndPreview'),
  confirmVideoEndPreviewEmpty: document.getElementById('confirmVideoEndPreviewEmpty'),
  confirmVideoKeyframeStatus: document.getElementById('confirmVideoKeyframeStatus'),
  confirmVideoGenerateImageBtn: document.getElementById('confirmVideoGenerateImageBtn'),
  confirmVideoSummary: document.getElementById('confirmVideoSummary'),
  confirmVideoProviderLabel: document.getElementById('confirmVideoProviderLabel'),
  confirmVideoBeatLabel: document.getElementById('confirmVideoBeatLabel'),
  confirmVideoPromptLabel: document.getElementById('confirmVideoPromptLabel'),
  confirmVideoNeedsImageNote: document.getElementById('confirmVideoNeedsImageNote'),
  confirmVideoNeedsImageBtn: document.getElementById('confirmVideoNeedsImageBtn'),

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
  entityModalAudioCaption: document.getElementById('entityModalAudioCaption'),
  entityModalSubtitleOverlay: document.getElementById('entityModalSubtitleOverlay'),
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
  timelineCaption: document.getElementById('timelineCaption'),
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
    const bullets = [`${total} shots · ${selectedLabel(providerSelect)}${extra}`];
    if (stats.versions) bullets.push(`${stats.scenes}/${total} shots already have a version — those are replaced too`);
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
    subtitlesAll: mediaConfig('Subtitles', 'subtitleVersions', els.subtitleStyleSelect, ' caption style'),
    planningReplan: (() => {
      const shrinking = context.fromCount != null && context.toCount != null && context.fromCount !== context.toCount;
      return {
        title: shrinking ? `Reduce to ${context.toCount} shots` : 'Replan story structure',
        paragraph: shrinking
          ? `Reducing from ${context.fromCount} to ${context.toCount} shots will rebuild the storyboard structure and retire media.`
          : 'This re-segments the story from the original script, discarding the current scene structure.',
        bullets: [
          `${context.toCount ?? total} shots, rebuilt from the original script`,
          `Prompts, images, audio, and video tied to replaced scenes are retired, not orphaned`,
        ],
        confirmLabel: 'Replan story structure',
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
  subtitles: { check: els.startRunSubtitlesCheck, status: els.startRunSubtitlesStatus },
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
  const selectionStatus = { planning: rowStatus.planning.ranged, images: rowStatus.images.ranged, audio: rowStatus.audio.ranged, video: rowStatus.video.ranged, subtitles: rowStatus.subtitles.ranged };
  return { scenes, range, rowStatus, selectionStatus };
}

function renderStartRunModal() {
  const { scenes, range, rowStatus, selectionStatus } = computeStartRunPlan();
  const selection = getStageSelection(selectionStatus);

  els.startRunSceneLabel.textContent = String(Math.min(range.startIndex + 1, Math.max(scenes.length, 1)));
  els.startRunSceneTotal.textContent = String(scenes.length);

  const rowEls = STAGE_ROW_ELS();
  for (const stage of ['planning', 'images', 'audio', 'video', 'subtitles']) {
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

let downloadConfirmResolve = null;

export function getZipSummary() {
  const allScenes = sceneStore.get().scenes || [];
  const exportScenes = allScenes.slice(0, 50);
  
  let imageCount = 0;
  let videoCount = 0;
  let audioCount = 0;
  
  for (const scene of exportScenes) {
    const activeImage = Array.isArray(scene.versions) 
      ? scene.versions[Number.isInteger(scene.activeVersionIndex) ? scene.activeVersionIndex : 0] 
      : null;
    if (activeImage?.path) imageCount++;
    
    const activeVideo = Array.isArray(scene.videoVersions) 
      ? scene.videoVersions[Number.isInteger(scene.activeVideoVersionIndex) ? scene.activeVideoVersionIndex : 0] 
      : null;
    if (activeVideo?.path) videoCount++;
    
    const activeAudio = Array.isArray(scene.audioVersions) 
      ? scene.audioVersions[Number.isInteger(scene.activeAudioVersionIndex) ? scene.activeAudioVersionIndex : 0] 
      : null;
    if (activeAudio?.path) audioCount++;
  }
  
  return {
    totalScenes: allScenes.length,
    exportedScenes: exportScenes.length,
    imageCount,
    videoCount,
    audioCount
  };
}

export function renderDownloadConfirmModal() {
  const summary = getZipSummary();
  
  els.downloadConfirmBullets.replaceChildren();
  
  const bulletData = [
    `${summary.exportedScenes} storyboard scene structure${summary.exportedScenes === 1 ? '' : 's'}`,
    `${summary.imageCount} generated image${summary.imageCount === 1 ? '' : 's'} (in images/ folder)`,
    `${summary.videoCount} generated video${summary.videoCount === 1 ? '' : 's'} (in videos/ folder)`,
    `${summary.audioCount} narration audio clip${summary.audioCount === 1 ? '' : 's'} (in audio/ folder)`,
    `1 Fountain screenplay source (script/screenplay.fountain)`,
    `1 storyboard metadata file (storyboard.json)`
  ];
  
  bulletData.forEach((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    els.downloadConfirmBullets.appendChild(li);
  });
  
  if (summary.totalScenes > 50) {
    els.downloadConfirmWarning.textContent = `Warning: Your storyboard has ${summary.totalScenes} scenes. The export tool packages only the first 50 scenes.`;
    els.downloadConfirmWarning.hidden = false;
  } else {
    els.downloadConfirmWarning.replaceChildren();
    els.downloadConfirmWarning.hidden = true;
  }
}

function openDownloadConfirmModal() {
  renderDownloadConfirmModal();
  els.downloadConfirmModal.returnValue = '';
  els.downloadConfirmModal.showModal();
  return new Promise((resolve) => { downloadConfirmResolve = resolve; });
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



// Read-only and informational: shot count is an output of planning now, not a target the user
// sets beforehand, so this just reflects however many shots the storyboard currently has. The
// shot limit (if any) is a ceiling passed into planning, not reflected back here as a target --
// noting it alongside the actual count just explains why the count may look capped.
function refreshShotCountDisplay() {
  if (!els.settingsShotCountDisplay) return;
  const count = sceneStore.get().scenes.length;
  const limit = els.settingsShotLimitSelect ? Number(els.settingsShotLimitSelect.value) || null : null;
  const base = count ? `${count} shot${count === 1 ? '' : 's'}` : 'Not planned yet';
  els.settingsShotCountDisplay.textContent = limit ? `${base} (limit: ${limit})` : base;
}

let screenplayEditorInstance = null;
let activeStudioPage = 'storyboard';
let pageSwitchToken = 0;
const STUDIO_PAGE_STORAGE_KEY = 'storyframe.activeStudioPage';

function applyStudioPage(page, { persist = true } = {}) {
  const activeButton = els.pageTabButtons.find((button) => button.dataset.page === page);
  if (!activeButton) return;

  els.pageTabButtons.forEach((button) => {
    const isActive = button === activeButton;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-selected', String(isActive));
    button.tabIndex = isActive ? 0 : -1;
  });
  els.pagePanels.forEach((panel) => {
    panel.hidden = panel.id !== activeButton.getAttribute('aria-controls');
  });
  activeStudioPage = page;
  if (persist) {
    try {
      localStorage.setItem(STUDIO_PAGE_STORAGE_KEY, page);
    } catch (_) {}
  }
  if (page === 'script' && els.scriptModeSelect?.value === 'screenplay' && !screenplayEditorInstance) {
    setScriptEditorMode('screenplay');
  }
}

async function switchStudioPage(page, { instant = false } = {}) {
  if (!els.pageTabButtons.some((button) => button.dataset.page === page)) return;
  if (page === activeStudioPage) {
    try {
      localStorage.setItem(STUDIO_PAGE_STORAGE_KEY, page);
    } catch (_) {}
    return;
  }
  if (instant || !els.pageTransition) {
    applyStudioPage(page);
    return;
  }

  const token = ++pageSwitchToken;
  const pageLabel = els.pageTabButtons.find((button) => button.dataset.page === page)?.textContent.trim() || 'page';
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  els.pageTransitionLabel.textContent = `Opening ${pageLabel}…`;
  els.pageTransition.hidden = false;

  // Give the browser a frame to paint the intermediary before changing a potentially heavy panel.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  if (token !== pageSwitchToken) return;
  els.pageTransition.classList.add('is-visible');
  await new Promise((resolve) => setTimeout(resolve, reducedMotion ? 60 : 150));
  if (token !== pageSwitchToken) return;

  applyStudioPage(page);
  els.pageTransition.classList.remove('is-visible');
  await new Promise((resolve) => setTimeout(resolve, reducedMotion ? 0 : 120));
  if (token !== pageSwitchToken) return;
  els.pageTransition.hidden = true;
}

function initPageTabs() {
  let savedPage = activeStudioPage;
  try {
    const storedPage = localStorage.getItem(STUDIO_PAGE_STORAGE_KEY);
    if (els.pageTabButtons.some((button) => button.dataset.page === storedPage)) savedPage = storedPage;
  } catch (_) {}
  applyStudioPage(savedPage, { persist: false });
  els.pageTabButtons.forEach((button) => {
    button.addEventListener('click', () => switchStudioPage(button.dataset.page));
  });
  els.pageTabs?.addEventListener('keydown', (event) => {
    const currentIndex = els.pageTabButtons.indexOf(document.activeElement);
    if (currentIndex < 0) return;
    let nextIndex;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % els.pageTabButtons.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + els.pageTabButtons.length) % els.pageTabButtons.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = els.pageTabButtons.length - 1;
    else return;
    event.preventDefault();
    els.pageTabButtons[nextIndex].focus();
    els.pageTabButtons[nextIndex].click();
  });
}

function setScriptFocusMode(enabled) {
  const isEnabled = Boolean(enabled);
  els.scriptPagePanel?.classList.toggle('is-script-focus', isEnabled);
  document.body.classList.toggle('script-focus-active', isEnabled);
  els.scriptFocusBtn?.setAttribute('aria-pressed', String(isEnabled));
  if (els.scriptFocusBtn) {
    els.scriptFocusBtn.title = isEnabled ? 'Exit distraction-free mode (Esc)' : 'Open distraction-free mode';
  }
  if (els.scriptFocusBtnLabel) {
    els.scriptFocusBtnLabel.textContent = isEnabled ? 'Exit full screen' : 'Full screen';
  }

  [document.querySelector('.storyboard-topbar'), els.pageTabs].forEach((element) => {
    if (!element) return;
    element.inert = isEnabled;
    if (isEnabled) element.setAttribute('aria-hidden', 'true');
    else element.removeAttribute('aria-hidden');
  });
}

function currentFountainScript() {
  if (screenplayEditorInstance && els.scriptModeSelect?.value === 'screenplay') {
    return screenplayEditorInstance.getRawScript('fountain');
  }
  return els.scriptText?.value || '';
}

function currentScriptExportSource() {
  if (screenplayEditorInstance && els.scriptModeSelect?.value === 'screenplay') {
    return screenplayEditorInstance.getScriptDocument();
  }
  return currentFountainScript();
}

function scriptFileBaseName() {
  const title = els.storyboardTitle?.value.trim() || 'screenplay';
  return title.toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'screenplay';
}

function downloadScriptFile(content, extension, mimeType) {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${scriptFileBaseName()}.${extension}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function closeScriptDownloadMenu({ restoreFocus = false } = {}) {
  if (!els.scriptDownloadMenu || !els.scriptDownloadBtn) return;
  els.scriptDownloadMenu.hidden = true;
  els.scriptDownloadBtn.setAttribute('aria-expanded', 'false');
  if (restoreFocus) els.scriptDownloadBtn.focus();
}

function exportCurrentScript(format) {
  const fountain = currentFountainScript();
  const formattedSource = currentScriptExportSource();
  const title = els.storyboardTitle?.value.trim() || 'Screenplay';
  if (format === 'fountain') downloadScriptFile(`${fountain.replace(/\s+$/, '')}\n`, 'fountain', 'text/plain;charset=utf-8');
  else if (format === 'fdx') downloadScriptFile(toFinalDraftXml(formattedSource), 'fdx', 'application/xml;charset=utf-8');
  else if (format === 'rtf') downloadScriptFile(toRichTextScript(formattedSource), 'rtf', 'application/rtf');
  else if (format === 'text') downloadScriptFile(`${toPlainScript(formattedSource).replace(/\s+$/, '')}\n`, 'txt', 'text/plain;charset=utf-8');
  else if (format === 'json') downloadScriptFile(toStructuredScriptJson(formattedSource), 'json', 'application/json;charset=utf-8');
  else if (format === 'print') {
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      setStatus('Allow pop-ups to print or save the screenplay as PDF.');
      return;
    }
    printWindow.opener = null;
    printWindow.document.open();
    printWindow.document.write(toPrintableScriptHtml(formattedSource, title));
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => printWindow.print(), 100);
  }
}

function updateScriptText(rawText, { emit = true } = {}) {
  if (els.scriptText.value !== rawText) {
    els.scriptText.value = rawText;
  }
  if (emit) {
    els.scriptText.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function setScriptEditorMode(mode) {
  const currentMode = mode || 'raw';
  try {
    localStorage.setItem('scriptEditorMode', currentMode);
  } catch (_) {}

  if (els.scriptModeSelect && els.scriptModeSelect.value !== currentMode) {
    els.scriptModeSelect.value = currentMode;
  }

  if (currentMode === 'screenplay') {
    const initialScript = els.scriptText.value || '';
    els.scriptText.hidden = true;
    if (els.screenplayEditorContainer) {
      els.screenplayEditorContainer.hidden = false;
      if (!screenplayEditorInstance) {
        if (!document.getElementById('scriptPagePanel')?.hidden) {
          screenplayEditorInstance = new ScreenplayEditor({
            container: els.screenplayEditorContainer,
            initialScript,
            format: 'fountain',
            showToolbar: true,
            onChange: ({ rawText }) => {
              updateScriptText(rawText, { emit: true });
            }
          });
        }
      } else {
        screenplayEditorInstance.loadScript(initialScript, 'fountain');
      }
    }
  } else {
    if (screenplayEditorInstance) {
      const serialized = screenplayEditorInstance.getRawScript('fountain');
      updateScriptText(serialized, { emit: true });
    }
    if (els.screenplayEditorContainer) {
      els.screenplayEditorContainer.hidden = true;
    }
    els.scriptText.hidden = false;
  }
}

async function loadStoryboardIntoUI() {
  const stylesLoaded = await runStage('Loading styles', () => loadStyles(els));
  const referencesLoaded = await runStage('Loading style references', () => loadStyleReferences(els.styleSelect.value, els, setStatus));
  const voicesLoaded = await runStage('Loading voices', () => refreshVoicesForCurrentProvider(setStatus));
  await runStage('Loading job history', () => refreshRecentJobs(projectStore.get().currentId));
  await runStage('Loading token spend', () => refreshSpend(projectStore.get().currentId));
  renderVoicesPanel(els);
  renderStageBar(els);
  renderScenes();
  refreshShotCountDisplay();
  if (screenplayEditorInstance && els.scriptModeSelect?.value === 'screenplay') {
    screenplayEditorInstance.loadScript(els.scriptText.value || '', 'fountain');
  }
  return stylesLoaded && referencesLoaded && voicesLoaded;
}

function attachEvents() {
  initPageTabs();
  const savedMode = (typeof localStorage !== 'undefined' && localStorage.getItem('scriptEditorMode')) || 'raw';
  setScriptEditorMode(savedMode);

  els.scriptModeSelect?.addEventListener('change', (e) => {
    setScriptEditorMode(e.target.value);
  });
  els.scriptFocusBtn?.addEventListener('click', () => {
    setScriptFocusMode(!els.scriptPagePanel.classList.contains('is-script-focus'));
  });
  els.scriptDownloadBtn?.addEventListener('click', () => {
    const willOpen = els.scriptDownloadMenu.hidden;
    els.scriptDownloadMenu.hidden = !willOpen;
    els.scriptDownloadBtn.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) els.scriptDownloadMenu.querySelector('[role="menuitem"]')?.focus();
  });
  els.scriptDownloadMenu?.addEventListener('click', (event) => {
    const option = event.target.closest('[data-script-format]');
    if (!option) return;
    exportCurrentScript(option.dataset.scriptFormat);
    closeScriptDownloadMenu();
  });
  document.addEventListener('click', (event) => {
    if (els.scriptDownloadMenu?.hidden || event.target === els.scriptDownloadBtn || els.scriptDownloadBtn?.contains(event.target)) return;
    if (!els.scriptDownloadMenu.contains(event.target)) closeScriptDownloadMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!els.scriptDownloadMenu?.hidden) {
      event.preventDefault();
      closeScriptDownloadMenu({ restoreFocus: true });
    } else if (els.scriptPagePanel?.classList.contains('is-script-focus')) {
      event.preventDefault();
      setScriptFocusMode(false);
      els.scriptFocusBtn?.focus();
    }
  }, true);
  const settingsModalPairs = [
    [els.settingsBtn, els.settingsModal],
  ];
  settingsModalPairs.forEach(([trigger, modal]) => {
    trigger.addEventListener('click', async () => {
      await refreshVoicesForCurrentProvider(setStatus);
      renderVoicesPanel(els);
      modal.showModal();
    });
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

  els.downloadConfirmCancelBtn.addEventListener('click', () => els.downloadConfirmModal.close());
  els.downloadConfirmCloseBtn.addEventListener('click', () => els.downloadConfirmModal.close());
  els.downloadConfirmRunBtn.addEventListener('click', () => els.downloadConfirmModal.close('confirm'));
  els.downloadConfirmModal.addEventListener('click', (event) => {
    if (event.target === els.downloadConfirmModal) els.downloadConfirmModal.close();
  });
  els.downloadConfirmModal.addEventListener('close', () => {
    const resolve = downloadConfirmResolve;
    downloadConfirmResolve = null;
    if (resolve) resolve(els.downloadConfirmModal.returnValue === 'confirm');
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
    saveStoryboard(els, false);
    renderStageBar(els);
  });
  els.commonPromptText.addEventListener('input', () => { saveStoryboard(els, false); renderStageBar(els); });
  [els.textProvider, els.imageProvider].forEach((el) => {
    el.addEventListener('change', () => saveStoryboard(els, false));
  });
  const selectedMediaSettings = ({ clearInheritedDuration = false } = {}) => ({
    version: 1,
    ...(els.mediaAspectRatio.value ? { aspectRatio: els.mediaAspectRatio.value } : {}),
    image: { resolutionTier: els.imageResolutionTier.value, quality: els.imageQuality.value },
    video: {
      resolutionTier: els.videoResolutionTier.value,
      ...(els.videoDurationSeconds?.value
        ? { durationSeconds: Number(els.videoDurationSeconds.value) }
        : (clearInheritedDuration ? { durationSeconds: null } : {})),
      ...(els.videoProvider?.value ? { provider: els.videoProvider.value } : {}),
    },
  });
  let mediaQuoteSequence = 0;
  let videoDurationOptionsSequence = 0;
  const currentProjectScope = () => {
    const currentRecord = getCurrentStoryboardRecord();
    return Number.isInteger(currentRecord?.revision) ? { projectId: projectStore.get().currentId } : {};
  };
  const refreshVideoDurationOptions = async () => {
    if (!els.videoDurationSeconds) return;
    const sequence = ++videoDurationOptionsSequence;
    const outputIntent = selectedMediaSettings({ clearInheritedDuration: true });
    try {
      const response = await fetch('/api/media-output/video-duration-options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(els.videoProvider?.value ? { provider: els.videoProvider.value } : {}),
          ...currentProjectScope(),
          outputIntent,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || 'Could not resolve video lengths');
      if (sequence !== videoDurationOptionsSequence) return;
      const results = new Map((body.options || []).map((item) => [String(item.durationSeconds), item]));
      for (const option of els.videoDurationSeconds.options) {
        const result = option.value ? results.get(option.value) : body.providerDefault;
        const baseLabel = option.dataset.baseLabel || option.textContent;
        option.disabled = result?.supported === false;
        option.title = result?.reason || '';
        if (!option.value && result?.supported) {
          const seconds = result.output?.resolved?.durationSeconds;
          option.textContent = seconds ? `${baseLabel} · ${seconds}s` : `${baseLabel} · Automatic`;
        } else {
          option.textContent = `${baseLabel}${result?.supported === false ? ' · Unsupported' : ''}`;
        }
      }
    } catch (error) {
      if (sequence !== videoDurationOptionsSequence) return;
      for (const option of els.videoDurationSeconds.options) {
        option.disabled = Boolean(option.value);
        option.textContent = `${option.dataset.baseLabel || option.textContent}${option.value ? ' · Unavailable' : ' · Automatic'}`;
        option.title = option.value ? 'Could not verify this duration against the server media policy.' : '';
      }
    }
  };
  const refreshMediaCostPreview = async () => {
    if (!els.mediaCostPreview) return;
    const sequence = ++mediaQuoteSequence;
    const quantity = Math.max(1, sceneStore.get().scenes.length || 1);
    const outputIntent = selectedMediaSettings({ clearInheritedDuration: true });
    const projectScope = currentProjectScope();
    try {
      const [imageQuote, videoQuote] = await Promise.all([
        fetch('/api/media-output/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modality: 'image', provider: els.imageProvider.value, ...projectScope, outputIntent, quantity }) }).then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body.error?.message || 'Image output is unsupported'); return body; }),
        fetch('/api/media-output/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modality: 'video', ...(els.videoProvider?.value ? { provider: els.videoProvider.value } : {}), ...projectScope, outputIntent, quantity }) }).then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body.error?.message || 'Video output is unsupported'); return body; }),
      ]);
      if (sequence !== mediaQuoteSequence) return;
      const describe = (result, label) => {
        const resolved = result.output.resolved;
        const dimensions = resolved.width && resolved.height ? `${resolved.width}×${resolved.height}` : resolved.providerSettings.resolution;
        const cost = result.estimate.available ? `${(Number(result.estimate.totalCreditMicros) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 3 })} tokens for ${quantity}` : 'price unavailable';
        const duration = resolved.durationSeconds ? `, ${resolved.durationSeconds}s` : '';
        return `${label}: ${dimensions}${duration}, ${cost}`;
      };
      els.mediaCostPreview.textContent = `${describe(imageQuote, 'Images')} · ${describe(videoQuote, 'Videos')}`;
    } catch (error) {
      if (sequence === mediaQuoteSequence) els.mediaCostPreview.textContent = error.message;
    }
  };
  [els.mediaAspectRatio, els.imageResolutionTier, els.imageQuality, els.videoResolutionTier, els.videoDurationSeconds, els.videoProvider].forEach((el) => el?.addEventListener('change', () => {
    saveStoryboard(els, false);
    refreshMediaCostPreview();
  }));
  [els.mediaAspectRatio, els.videoResolutionTier, els.videoProvider].forEach((el) => el?.addEventListener('change', refreshVideoDurationOptions));
  els.imageProvider.addEventListener('change', refreshMediaCostPreview);
  els.saveMediaDefaultsBtn?.addEventListener('click', async () => {
    if (!els.mediaAspectRatio.value) { els.mediaCostPreview.textContent = 'Choose a shared aspect ratio before saving defaults for new projects.'; return; }
    if (els.videoDurationSeconds?.selectedOptions[0]?.disabled) { els.mediaCostPreview.textContent = 'Choose a video length supported by the selected provider and resolution.'; return; }
    try {
      const response = await fetch('/api/auth/preferences/media', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(selectedMediaSettings()) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || 'Could not save media defaults');
      els.mediaCostPreview.textContent = 'Saved as your defaults for new projects. Existing projects are unchanged.';
    } catch (error) { els.mediaCostPreview.textContent = error.message; }
  });
  els.videoMotionIntensity.addEventListener('change', () => saveStoryboard(els, false));
  els.enrichNarration.addEventListener('change', () => saveStoryboard(els, false));

  els.downloadZipBtn.addEventListener('click', async () => {
    const confirmed = await openDownloadConfirmModal();
    if (confirmed) {
      await downloadZip(setStatus);
    }
  });

  // --- Settings: visual planning mode, read-only shot count, danger zone ------
  //
  // These replace the removed Planning modal and per-stage dialog. What used to be interactive
  // mid-run decisions are now pre-configured once in Settings (existing modal, existing pattern)
  // and read synchronously when Start needs them — no extra dialog appears mid-flow. Shot count
  // itself is no longer a setting: it's an output of planning, shown read-only for visibility.

  const syncPlanningModeFromEnrich = () => {
    if (els.planningModeSelect) {
      els.planningModeSelect.value = els.enrichNarration.checked ? 'auto' : 'script';
    }
  };
  els.settingsBtn.addEventListener('click', () => {
    syncPlanningModeFromEnrich();
    refreshShotCountDisplay();
    refreshVideoDurationOptions();
    refreshMediaCostPreview();
  });

  if (els.planningModeSelect) {
    els.planningModeSelect.addEventListener('change', () => {
      els.enrichNarration.checked = els.planningModeSelect.value === 'auto';
      saveStoryboard(els, false);
    });
  }

  if (els.settingsShotLimitSelect) {
    els.settingsShotLimitSelect.addEventListener('change', () => {
      refreshShotCountDisplay();
      saveStoryboard(els, false);
    });
  }

  els.settingsReplanBtn.addEventListener('click', async () => {
    if (!(await requestGenerationConfirmation('planningReplan', {}))) return;
    await replanStory(els, setStatus);
    await Promise.all([
      refreshRecentJobs(projectStore.get().currentId),
      refreshSpend(projectStore.get().currentId)
    ]);
    renderStageBar(els);
    renderScenes();
  });
  const wireRegenerateAll = (button, stage, kind) => {
    button.addEventListener('click', async () => {
      if (!(await requestGenerationConfirmation(kind))) return;
      setStatus(`Regenerating all ${stage}...`);
      await regenerateAllStage(stage, els, setStatus);
      await Promise.all([
        refreshRecentJobs(projectStore.get().currentId),
        refreshSpend(projectStore.get().currentId)
      ]);
      renderStageBar(els);
      renderScenes();
    });
  };
  wireRegenerateAll(els.settingsRegenerateImagesBtn, 'images', 'imagesAll');
  wireRegenerateAll(els.settingsRegenerateAudioBtn, 'audio', 'audioAll');
  wireRegenerateAll(els.settingsRegenerateVideoBtn, 'video', 'videoAll');
  wireRegenerateAll(els.settingsRegenerateSubtitlesBtn, 'subtitles', 'subtitlesAll');

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
    const stages = ['planning', 'images', 'audio', 'video', 'subtitles'].filter((stage) => selection[stage]);
    if (!stages.length) { setStatus('Nothing selected to start — check a step above.'); return; }
    const forceStages = computeForceStages(rowStatus, selection);

    setStatus('Starting...');
    const result = await runCreateStoryFlow('custom', els, setStatus, { stages, range, forceStages });
    if (result.stoppedAt) setStatus(`Stopped: ${result.stoppedAt}.`);
    else setStatus('Done.');
    await Promise.all([
      refreshRecentJobs(projectStore.get().currentId),
      refreshSpend(projectStore.get().currentId)
    ]);
    renderStageBar(els);
    renderScenes();
  });

  els.styleSelect.addEventListener('change', async () => {
    if (els.stageStyleSelect && els.stageStyleSelect.value !== els.styleSelect.value) {
      els.stageStyleSelect.value = els.styleSelect.value;
    }
    const styleId = els.styleSelect.value;
    prefillCommonPrompt(styleId, els);
    saveStoryboard(els, false);
    renderStageBar(els);
    await loadStyleReferences(styleId, els, setStatus);
  });
  if (els.stageStyleSelect) {
    els.stageStyleSelect.addEventListener('change', () => {
      if (els.styleSelect.value !== els.stageStyleSelect.value) {
        els.styleSelect.value = els.stageStyleSelect.value;
        els.styleSelect.dispatchEvent(new Event('change'));
      }
    });
  }
  els.characterRefInput.addEventListener('change', (e) => uploadStyleReferences('characters', e.target.files, els, setStatus));
  els.worldRefInput.addEventListener('change', (e) => uploadStyleReferences('world', e.target.files, els, setStatus));

  els.audioProvider.addEventListener('change', async (e) => {
    voiceStore.set({ audioProvider: e.target.value });
    await refreshVoicesForCurrentProvider(setStatus);
    renderVoicesPanel(els);
    saveStoryboard(els, false);
  });
  els.closeVoiceLibraryBtn.addEventListener('click', () => els.voiceLibraryModal.close());
  els.voiceLibraryModal.addEventListener('click', (event) => {
    if (event.target === els.voiceLibraryModal) els.voiceLibraryModal.close();
  });
  els.voiceLibraryModal.addEventListener('close', () => {
    closeVoiceLibraryCleanup(els);
    renderVoicesPanel(els);
  });
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

  els.tokensInfoBtn.addEventListener('click', () => {
    populateTokensInfoModal(els);
    els.tokensInfoModal.showModal();
  });
  els.tokensInfoModalCloseBtn.addEventListener('click', () => els.tokensInfoModal.close());
  els.tokensInfoModalDoneBtn.addEventListener('click', () => els.tokensInfoModal.close());
  els.tokensInfoModal.addEventListener('click', (event) => {
    if (event.target === els.tokensInfoModal) els.tokensInfoModal.close();
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

if (window.location.pathname !== '/test.html') {
  init().catch(err => {
    console.error("Failed to init app:", err);
    setStatus("Failed to initialize app.");
  });
}
