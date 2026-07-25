import { projectStore, sceneStore, voiceStore, uiStore, batchStore, spendStore } from './core/store.js';
import { restoreStoryboardLibrary, openStoryboard, createStoryboard, saveStoryboard, getCurrentStoryboardRecord, setPersistenceScope, findStoryboardForRoute } from './core/persistence.js';
import { parseWorkPath } from './core/app-paths.js';
import { initWorkbar } from './shared/workbar.js';
import { initRendering, renderScenes, renderEntityOperationState } from './studio/rendering.js';
import { initTimeline } from './studio/timeline.js';
import { renderStoryboardPicker, loadStyles, loadStyleReferences, uploadStyleReferences, prefillCommonPrompt, renderVoicesPanel, renderStageBar, renderRunResults, renderStyleReferenceOperationState, initImageLibraryModal, openImageLibrary, populateTokensInfoModal } from './studio/ui.js';
import { downloadZip } from './generation/workflows.js';
import { initializeAuth } from './core/auth.js';
import { refreshRecentJobs, refreshSpend, replanStory, regenerateAllStage, retryFailedStage, runCreateStoryFlow } from './generation/stages.js';
import {
  refreshVoicesForCurrentProvider, cloneVoice, switchMicrophone,
  closeVoiceLibraryCleanup, toggleVoiceRecording,
  renderVoiceLibraryList, resetVoiceRecordingUI, voiceRecordingState,
  stopPreviewVoice,
} from './media/voices.js';

import { initMediaSettings } from './media/media-settings.js';
import { initScriptController } from './scripts/controller.js';
import { initScriptPublishControls } from './scripts/publish.js';
import { initRunController } from './studio/run-controller.js';
import { assertElements } from './core/dom-contract.js';
import { initStoryboardController } from './studio/storyboard-controller.js';
import { initSettingsController } from './studio/settings-controller.js';
import { initNarrationController } from './studio/narration-controller.js';
import { initStyleController } from './studio/style-controller.js';
import { initCustomStylesController } from './studio/custom-styles-controller.js';

export { getZipSummary } from './studio/storyboard-controller.js';

const els = {
  // Elements
  scriptText: document.getElementById('scriptText'),
  scriptModeSelect: document.getElementById('scriptModeSelect'),
  screenplayEditorContainer: document.getElementById('screenplayEditorContainer'),
  screenplayToolbarHost: document.getElementById('screenplayToolbarHost'),
  scriptPagePanel: document.getElementById('scriptPagePanel'),
  scriptFocusBtn: document.getElementById('scriptFocusBtn'),
  scriptFocusBtnLabel: document.getElementById('scriptFocusBtnLabel'),
  scriptDownloadBtn: document.getElementById('scriptDownloadBtn'),
  scriptDownloadMenu: document.getElementById('scriptDownloadMenu'),
  scriptShareBtn: document.getElementById('scriptShareBtn'),
  workVisibilityToggle: document.getElementById('workVisibilityToggle'),
  workShareBtn: document.getElementById('workShareBtn'),
  scriptMetaBtn: document.getElementById('scriptMetaBtn'),
  scriptMetaModal: document.getElementById('scriptMetaModal'),
  scriptMetaCloseBtn: document.getElementById('scriptMetaCloseBtn'),
  scriptMetaCancelBtn: document.getElementById('scriptMetaCancelBtn'),
  scriptLogline: document.getElementById('scriptLogline'),
  scriptCategorySelect: document.getElementById('scriptCategorySelect'),
  scriptTagsInput: document.getElementById('scriptTagsInput'),
  scriptMetaSaveBtn: document.getElementById('scriptMetaSaveBtn'),
  scriptStatsLine: document.getElementById('scriptStatsLine'),

  // Studio page navigation
  pageTabs: document.querySelector('.sf-artifact-tabs') || document.querySelector('.page-tabs'),
  pageTabButtons: Array.from(document.querySelectorAll('.sf-artifact-tab[data-page], .page-tab[data-page]')),
  pagePanels: Array.from(document.querySelectorAll('[role="tabpanel"]')),
  pageTransition: document.getElementById('pageTransition'),
  pageTransitionLabel: document.getElementById('pageTransitionLabel'),
  narrationModeSelect: document.getElementById('narrationModeSelect'),
  narrationGuidance: document.getElementById('narrationGuidance'),
  narrationPromptText: document.getElementById('narrationPromptText'),
  narrationPromptReset: document.getElementById('narrationPromptReset'),

  storyboardAddSceneBtn: document.getElementById('storyboardAddSceneBtn'),
  addSceneDialog: document.getElementById('addSceneDialog'),
  addScenePosition: document.getElementById('addScenePosition'),
  addSceneCancel: document.getElementById('addSceneCancel'),
  addSceneConfirm: document.getElementById('addSceneConfirm'),

  styleSelect: document.getElementById('styleSelect'),
  stageStyleSelect: document.getElementById('stageStyleSelect'),
  customStylesBtn: document.getElementById('customStylesBtn'),
  stageCustomStylesBtn: document.getElementById('stageCustomStylesBtn'),
  customStylesModal: document.getElementById('customStylesModal'),
  customStylesCloseBtn: document.getElementById('customStylesCloseBtn'),
  customStyleNewBtn: document.getElementById('customStyleNewBtn'),
  customStylesList: document.getElementById('customStylesList'),
  customStyleEditor: document.getElementById('customStyleEditor'),
  customStyleFields: document.getElementById('customStyleFields'),
  customStyleCharacterGenerateBtn: document.getElementById('customStyleCharacterGenerateBtn'),
  customStyleWorldGenerateBtn: document.getElementById('customStyleWorldGenerateBtn'),
  customStyleCharacterLibraryBtn: document.getElementById('customStyleCharacterLibraryBtn'),
  customStyleWorldLibraryBtn: document.getElementById('customStyleWorldLibraryBtn'),
  customStyleCharacterUploadBtn: document.getElementById('customStyleCharacterUploadBtn'),
  customStyleWorldUploadBtn: document.getElementById('customStyleWorldUploadBtn'),
  customStyleTitle: document.getElementById('customStyleTitle'),
  customStylePrompt: document.getElementById('customStylePrompt'),
  customStyleWritingGuidance: document.getElementById('customStyleWritingGuidance'),
  customStyleSaveBtn: document.getElementById('customStyleSaveBtn'),
  customStyleStatus: document.getElementById('customStyleStatus'),
  customStyleCharacterInput: document.getElementById('customStyleCharacterInput'),
  customStyleWorldInput: document.getElementById('customStyleWorldInput'),
  customStyleCharacterRefs: document.getElementById('customStyleCharacterRefs'),
  customStyleWorldRefs: document.getElementById('customStyleWorldRefs'),
  imageLibraryModal: document.getElementById('imageLibraryModal'),
  commonPromptText: document.getElementById('commonPromptText'),

  styleRefLightbox: document.getElementById('styleRefLightbox'),
  styleRefLightboxImage: document.getElementById('styleRefLightboxImage'),
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
  aspectRatioHelper: document.getElementById('aspectRatioHelper'),
  videoProviderHelper: document.getElementById('videoProviderHelper'),
  videoDurationHelper: document.getElementById('videoDurationHelper'),
  audioProviderHelper: document.getElementById('audioProviderHelper'),
  audioProvider: document.getElementById('audioProvider'),
  videoMotionIntensity: document.getElementById('videoMotionIntensity'),
  subtitleStyleSelect: document.getElementById('subtitleStyleSelect'),
  fallbackPolicy: document.getElementById('fallbackPolicy'),
  enrichNarration: document.getElementById('enrichNarration'),
  statusText: document.getElementById('statusText'),
  statusPanel: document.getElementById('statusPanel'),
  generationSummaryText: document.getElementById('generationSummaryText'),
  runResultsPanel: document.getElementById('runResultsPanel'),
  runResultsRows: document.getElementById('runResultsRows'),
  runResultsDismissBtn: document.getElementById('runResultsDismissBtn'),
  storyboardSection: document.getElementById('storyboardSection'),
  storyboardGrid: document.getElementById('storyboardGrid'),
  storyboardSlider: document.getElementById('storyboardSlider'),
  storyboardViewToggle: document.querySelector('.view-type'),
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
  startRunRegenerateIfExists: document.getElementById('startRunRegenerateIfExists'),
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
  confirmRegenProviderKindLabel: document.getElementById('confirmRegenProviderKindLabel'),
  confirmVideoProviderLabel: document.getElementById('confirmVideoProviderLabel'),
  confirmVideoBeatRow: document.getElementById('confirmVideoBeatRow'),
  confirmVideoBeatLabel: document.getElementById('confirmVideoBeatLabel'),
  confirmVideoPromptRow: document.getElementById('confirmVideoPromptRow'),
  confirmVideoPromptLabel: document.getElementById('confirmVideoPromptLabel'),
  confirmVideoNeedsImageNote: document.getElementById('confirmVideoNeedsImageNote'),
  confirmVideoNeedsImageBtn: document.getElementById('confirmVideoNeedsImageBtn'),

  // Scene entity modal
  entityModal: document.getElementById('entityModal'),
  entityModalSceneLabel: document.getElementById('entityModalSceneLabel'),
  entityModalTitle: document.getElementById('entityModalTitle'),
  entityModalSummary: document.getElementById('entityModalSummary'),
  entityModalPosition: document.getElementById('entityModalPosition'),
  entityModalPreviousBtn: document.getElementById('entityModalPreviousBtn'),
  entityModalNextBtn: document.getElementById('entityModalNextBtn'),
  closeEntityModalBtn: document.getElementById('closeEntityModalBtn'),
  entityModalSourceText: document.getElementById('entityModalSourceText'),
  entityControllerRows: document.getElementById('entityControllerRows'),
  entityModalDetail: document.getElementById('entityModalDetail'),
  entityModalDetailTitle: document.getElementById('entityModalDetailTitle'),
  entityModalDetailCloseBtn: document.getElementById('entityModalDetailCloseBtn'),
  entityModalDeleteBtn: document.getElementById('entityModalDeleteBtn'),
  entityModalBeatField: document.getElementById('entityModalBeatField'),
  entityModalBeat: document.getElementById('entityModalBeat'),
  entityModalVideoPromptField: document.getElementById('entityModalVideoPromptField'),
  entityModalVideoPrompt: document.getElementById('entityModalVideoPrompt'),
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
  entityModalMediaMeta: document.getElementById('entityModalMediaMeta'),
  entityModalImage: document.getElementById('entityModalImage'),
  entityModalVideo: document.getElementById('entityModalVideo'),
  entityModalAudio: document.getElementById('entityModalAudio'),
  entityModalAudioCaption: document.getElementById('entityModalAudioCaption'),
  entityModalRecordAudioBtn: document.getElementById('entityModalRecordAudioBtn'),
  sceneAudioRecorder: document.getElementById('sceneAudioRecorder'),
  sceneAudioRecordImage: document.getElementById('sceneAudioRecordImage'),
  sceneAudioRecordVideo: document.getElementById('sceneAudioRecordVideo'),
  sceneAudioRecordEmpty: document.getElementById('sceneAudioRecordEmpty'),
  sceneAudioMicSelect: document.getElementById('sceneAudioMicSelect'),
  sceneAudioMonitorMic: document.getElementById('sceneAudioMonitorMic'),
  sceneAudioReduceNoise: document.getElementById('sceneAudioReduceNoise'),
  sceneAudioWaveform: document.getElementById('sceneAudioWaveform'),
  sceneAudioRecordStatus: document.getElementById('sceneAudioRecordStatus'),
  sceneAudioRecordPreview: document.getElementById('sceneAudioRecordPreview'),
  sceneAudioRecordToggle: document.getElementById('sceneAudioRecordToggle'),
  sceneAudioPreviewBtn: document.getElementById('sceneAudioPreviewBtn'),
  sceneAudioRetakeBtn: document.getElementById('sceneAudioRetakeBtn'),
  sceneAudioSubmitBtn: document.getElementById('sceneAudioSubmitBtn'),
  sceneAudioCancelBtn: document.getElementById('sceneAudioCancelBtn'),
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

let scriptController = null;
let scriptPublishControls = null;
let storyboardController = null;
let settingsController = null;

async function loadStoryboardIntoUI() {
  // Make the selected work usable before optional provider/catalog requests settle.
  renderVoicesPanel(els);
  renderStageBar(els);
  renderScenes();
  settingsController?.refreshShotCount();
  scriptController?.syncFromText();
  scriptPublishControls?.syncFromRecord(getCurrentStoryboardRecord());
  setStatus('Ready. Loading generation options…');

  const projectId = projectStore.get().currentId;
  const stylesAndReferences = runStage('Loading styles', () => loadStyles(els))
    .then((loaded) => loaded && projectStore.get().currentId === projectId
      ? runStage('Loading style references', () => loadStyleReferences(els.styleSelect.value, els, setStatus))
      : false);
  Promise.all([
    stylesAndReferences,
    runStage('Loading voices', () => refreshVoicesForCurrentProvider(setStatus)),
    runStage('Loading job history', () => refreshRecentJobs(projectId)),
    runStage('Loading token spend', () => refreshSpend(projectId)),
  ]).then(() => {
    if (projectStore.get().currentId === projectId) {
      renderVoicesPanel(els);
      renderStageBar(els);
    }
  });
  return true;
}

function initControllers(getSession) {
  scriptPublishControls = initScriptPublishControls({
    scriptText: els.scriptText,
    scriptShareBtn: els.scriptShareBtn,
    workVisibilityToggle: els.workVisibilityToggle,
    workShareBtn: els.workShareBtn,
    scriptMetaBtn: els.scriptMetaBtn,
    scriptMetaModal: els.scriptMetaModal,
    scriptMetaCloseBtn: els.scriptMetaCloseBtn,
    scriptMetaCancelBtn: els.scriptMetaCancelBtn,
    scriptLogline: els.scriptLogline,
    scriptCategorySelect: els.scriptCategorySelect,
    scriptTagsInput: els.scriptTagsInput,
    scriptMetaSaveBtn: els.scriptMetaSaveBtn,
    scriptStatsLine: els.scriptStatsLine,
  }, { setStatus });
  scriptController = initScriptController({
    scriptText: els.scriptText,
    modeSelect: els.scriptModeSelect,
    editorContainer: els.screenplayEditorContainer,
    toolbarHost: els.screenplayToolbarHost,
    pagePanel: els.scriptPagePanel,
    focusBtn: els.scriptFocusBtn,
    focusBtnLabel: els.scriptFocusBtnLabel,
    downloadBtn: els.scriptDownloadBtn,
    downloadMenu: els.scriptDownloadMenu,
    pageTabs: els.pageTabs,
    pageTabButtons: els.pageTabButtons,
    pagePanels: els.pagePanels,
    pageTransition: els.pageTransition,
    pageTransitionLabel: els.pageTransitionLabel,
    storyboardTitle: els.storyboardTitle,
  }, {
    setStatus,
    getCurrentRecord: getCurrentStoryboardRecord,
    getSession,
    onPageChange: () => {
      scriptPublishControls?.syncFromRecord(getCurrentStoryboardRecord());
    },
    onScriptChange: () => {
      saveStoryboard(els, false);
      renderStageBar(els);
      scriptController?.syncRoute?.();
    },
  });
  storyboardController = initStoryboardController({
    title: els.storyboardTitle,
    pickerToggle: els.storyboardPickerToggle,
    pickerList: els.storyboardPickerList,
    newBtn: els.newStoryboardBtn,
    saveBtn: els.saveStateBtn,
    grid: els.storyboardGrid,
    slider: els.storyboardSlider,
    viewToggle: els.storyboardViewToggle,
    resizeList: els.resizeSceneList,
    downloadBtn: els.downloadZipBtn,
    downloadModal: els.downloadConfirmModal,
    downloadCloseBtn: els.downloadConfirmCloseBtn,
    downloadCancelBtn: els.downloadConfirmCancelBtn,
    downloadRunBtn: els.downloadConfirmRunBtn,
    downloadWarning: els.downloadConfirmWarning,
    downloadBullets: els.downloadConfirmBullets,
  }, {
    createProject: () => {
      createStoryboard(els);
      scriptController?.syncRoute?.();
    },
    getCurrentRecord: getCurrentStoryboardRecord,
    openProject: (id) => {
      openStoryboard(id, els);
      scriptController?.syncRoute?.();
    },
    saveProject: (immediate) => saveStoryboard(els, immediate),
    renderPicker: () => renderStoryboardPicker(els),
    loadStoryboardIntoUI,
    renderScenes,
    downloadProject: () => downloadZip(setStatus),
  });
  const mediaSettings = initMediaSettings({
    aspectRatio: els.mediaAspectRatio,
    imageProvider: els.imageProvider,
    imageResolutionTier: els.imageResolutionTier,
    imageQuality: els.imageQuality,
    videoProvider: els.videoProvider,
    videoResolutionTier: els.videoResolutionTier,
    videoDurationSeconds: els.videoDurationSeconds,
    costPreview: els.mediaCostPreview,
    saveDefaultsBtn: els.saveMediaDefaultsBtn,
    aspectRatioHelper: els.aspectRatioHelper,
    videoProviderHelper: els.videoProviderHelper,
    videoDurationHelper: els.videoDurationHelper,
    audioProviderHelper: els.audioProviderHelper,
    audioProvider: els.audioProvider,
  }, {
    saveProject: () => saveStoryboard(els, false),
    getQuantity: () => sceneStore.get().scenes.length,
    getProjectScope: () => {
      const record = getCurrentStoryboardRecord();
      return Number.isInteger(record?.revision) ? { projectId: projectStore.get().currentId } : {};
    },
  });
  initRunController({
    textProvider: els.textProvider,
    imageProvider: els.imageProvider,
    audioProvider: els.audioProvider,
    videoMotionIntensity: els.videoMotionIntensity,
    subtitleStyle: els.subtitleStyleSelect,
    confirmModal: els.generationConfirmModal,
    confirmTitle: els.generationConfirmTitle,
    confirmIntro: els.generationConfirmIntro,
    confirmBullets: els.generationConfirmBullets,
    confirmCloseBtn: els.generationConfirmCloseBtn,
    confirmCancelBtn: els.generationConfirmCancelBtn,
    confirmRunBtn: els.generationConfirmRunBtn,
    startModal: els.startRunModal,
    sceneLabel: els.startRunSceneLabel,
    sceneTotal: els.startRunSceneTotal,
    rangeAll: els.startRunRangeAll,
    rangeNext: els.startRunRangeNext,
    nextCount: els.startRunNextCount,
    regenerateIfExists: els.startRunRegenerateIfExists,
    startCloseBtn: els.startRunCloseBtn,
    startCancelBtn: els.startRunCancelBtn,
    startConfirmBtn: els.startRunConfirmBtn,
    planningCheck: els.startRunPlanningCheck,
    planningStatus: els.startRunPlanningStatus,
    imagesCheck: els.startRunImagesCheck,
    imagesStatus: els.startRunImagesStatus,
    audioCheck: els.startRunAudioCheck,
    audioStatus: els.startRunAudioStatus,
    videoCheck: els.startRunVideoCheck,
    videoStatus: els.startRunVideoStatus,
    subtitlesCheck: els.startRunSubtitlesCheck,
    subtitlesStatus: els.startRunSubtitlesStatus,
    replanBtn: els.settingsReplanBtn,
    regenerateImagesBtn: els.settingsRegenerateImagesBtn,
    regenerateAudioBtn: els.settingsRegenerateAudioBtn,
    regenerateVideoBtn: els.settingsRegenerateVideoBtn,
    regenerateSubtitlesBtn: els.settingsRegenerateSubtitlesBtn,
    startPauseBtn: els.startPauseBtn,
    runResultsPanel: els.runResultsPanel,
    runResultsRows: els.runResultsRows,
    runResultsDismissBtn: els.runResultsDismissBtn,
  }, {
    setStatus,
    replan: () => replanStory(els, setStatus),
    regenerate: (stage) => regenerateAllStage(stage, els, setStatus),
    runFlow: (options) => runCreateStoryFlow('custom', els, setStatus, options),
    retryFailed: (stage) => retryFailedStage(stage, els, setStatus),
    renderStatus: () => renderStageBar(els),
    renderStoryboard: renderScenes,
    renderRunResults: (results) => renderRunResults(els, results),
  });

  settingsController = initSettingsController({
    settingsBtn: els.settingsBtn,
    settingsModal: els.settingsModal,
    planningMode: els.planningModeSelect,
    shotCount: els.settingsShotCountDisplay,
    shotLimit: els.settingsShotLimitSelect,
    enrichNarration: els.enrichNarration,
    textProvider: els.textProvider,
    videoMotionIntensity: els.videoMotionIntensity,
    audioProvider: els.audioProvider,
    voiceLibraryModal: els.voiceLibraryModal,
    closeVoiceLibraryBtn: els.closeVoiceLibraryBtn,
    voiceMicSelect: els.voiceMicSelect,
    voiceRecordBtn: els.voiceRecordBtn,
    voiceSaveBtn: els.voiceSaveBtn,
    voiceNameInput: els.voiceNameInput,
    tokensInfoBtn: els.tokensInfoBtn,
    tokensInfoModal: els.tokensInfoModal,
    tokensCloseBtn: els.tokensInfoModalCloseBtn,
    tokensDoneBtn: els.tokensInfoModalDoneBtn,
  }, {
    getShotCount: () => sceneStore.get().scenes.length,
    refreshMediaSettings: () => mediaSettings.refreshAll(),
    saveProject: (immediate) => saveStoryboard(els, immediate),
    refreshVoices: () => refreshVoicesForCurrentProvider(setStatus),
    renderVoices: () => renderVoicesPanel(els),
    renderStageBar: () => renderStageBar(els),
    setAudioProvider: (audioProvider) => voiceStore.set({ audioProvider }),
    closeVoiceLibrary: () => closeVoiceLibraryCleanup(els),
    switchMicrophone: (deviceId) => switchMicrophone(deviceId, els),
    toggleVoiceRecording: () => toggleVoiceRecording(els),
    getRecordedVoice: () => voiceRecordingState.recordedBlob,
    cloneVoice: (blob, name) => cloneVoice(blob, name, setStatus),
    resetVoiceRecording: () => resetVoiceRecordingUI(els),
    renderVoiceLibrary: () => renderVoiceLibraryList(els, setStatus),
    populateTokensInfo: () => populateTokensInfoModal(els),
    stopPreviewVoice,
    setStatus,
  });

  initNarrationController({
    mode: els.narrationModeSelect,
    guidance: els.narrationGuidance,
    promptText: els.narrationPromptText,
    promptReset: els.narrationPromptReset,
    addSceneBtn: els.storyboardAddSceneBtn,
    addSceneDialog: els.addSceneDialog,
    addScenePosition: els.addScenePosition,
    addSceneCancel: els.addSceneCancel,
    addSceneConfirm: els.addSceneConfirm,
    enrichNarration: els.enrichNarration,
  }, {
    setStatus,
    saveProject: (immediate) => saveStoryboard(els, immediate),
    renderVoices: () => renderVoicesPanel(els),
  });

  // Passed as the shared `els` object itself (not a remapped wrapper, unlike other controllers
  // here) because it sets els.onStyleReferenceReorder/onStyleReferenceInspect callbacks that
  // ui.js's renderStyleReferenceList reads off the same `els` instance passed to renderStyleReferences.
  initStyleController(els, {
    setStatus,
    saveProject: (immediate) => saveStoryboard(els, immediate),
    renderStageBar: () => renderStageBar(els),
    prefillCommonPrompt: (styleId) => prefillCommonPrompt(styleId, els),
    loadStyleReferences: (styleId) => loadStyleReferences(styleId, els, setStatus),
    uploadStyleReferences: (kind, files) => uploadStyleReferences(kind, files, els, setStatus),
  });
  initCustomStylesController(els, {
    refreshStyles: () => loadStyles(els),
    loadStyleReferences: (styleId) => loadStyleReferences(styleId, els, setStatus),
    saveProject: (immediate) => saveStoryboard(els, immediate),
    openImageLibrary: (options) => openImageLibrary(options),
    setStatus,
  });

  // Watchers for basic UI updates
  sceneStore.subscribe(() => renderStageBar(els));
  uiStore.subscribe(() => {
    renderStageBar(els);
    renderStyleReferenceOperationState(els);
    renderEntityOperationState();
  });
  batchStore.subscribe(() => renderStageBar(els));
  spendStore.subscribe(() => {
    renderStageBar(els);
    settingsController?.refreshTokensIfOpen();
  });
}

async function init() {
  assertElements('Studio shell', els, [
    'statusText', 'statusPanel', 'runResultsPanel', 'runResultsRows', 'runResultsDismissBtn',
    'storyboardGrid', 'storyboardSlider', 'storyboardViewToggle', 'sceneCardTemplate', 'storyboardTitle',
    'storyboardPickerToggle', 'storyboardPickerList', 'newStoryboardBtn',
    'saveStateBtn', 'resizeSceneList', 'downloadZipBtn', 'downloadConfirmModal',
    'downloadConfirmCloseBtn', 'downloadConfirmCancelBtn', 'downloadConfirmRunBtn',
    'downloadConfirmWarning', 'downloadConfirmBullets', 'settingsBtn',
    'settingsModal', 'planningModeSelect', 'settingsShotCountDisplay',
    'settingsShotLimitSelect', 'commonPromptText', 'textProvider',
    'videoMotionIntensity', 'enrichNarration', 'styleSelect', 'stageStyleSelect',
    'customStylesBtn', 'stageCustomStylesBtn', 'customStylesModal', 'customStylesCloseBtn',
    'customStyleNewBtn', 'customStylesList', 'customStyleEditor',
    'customStyleCharacterGenerateBtn', 'customStyleWorldGenerateBtn', 'customStyleCharacterLibraryBtn',
    'customStyleWorldLibraryBtn', 'customStyleCharacterUploadBtn', 'customStyleWorldUploadBtn',
    'imageLibraryModal', 'imageProvider',
    'customStyleFields', 'customStyleTitle', 'customStylePrompt', 'customStyleWritingGuidance', 'customStyleSaveBtn',
    'customStyleStatus', 'customStyleCharacterInput',
    'customStyleWorldInput', 'customStyleCharacterRefs', 'customStyleWorldRefs',
    'narrationModeSelect', 'narrationGuidance', 'narrationPromptText',
    'narrationPromptReset',
    'storyboardAddSceneBtn', 'addSceneDialog', 'addScenePosition', 'addSceneCancel',
    'addSceneConfirm',
    'characterRefInput', 'worldRefInput', 'audioProvider', 'voiceLibraryModal',
    'closeVoiceLibraryBtn', 'voiceMicSelect', 'voiceRecordBtn', 'voiceSaveBtn',
    'voiceNameInput', 'tokensInfoBtn', 'tokensInfoModal',
    'tokensInfoModalCloseBtn', 'tokensInfoModalDoneBtn',
    'styleRefLightbox', 'styleRefLightboxImage',
  ]);
  initRendering(els);
  initTimeline(els);
  initImageLibraryModal(els, setStatus);

  const session = await initializeAuth();
  if (!session) {
    setStatus('Log in to open your storyboards.');
    return;
  }
  setPersistenceScope(session.tenant.id);
  initControllers(() => session);

  const startupParams = new URLSearchParams(window.location.search);
  const route = parseWorkPath(window.location.pathname);
  const restored = await runStage('Restoring your storyboards', () => restoreStoryboardLibrary(els, {
    targetProjectId: startupParams.get('project'),
    targetWorkSlug: route?.workSlug,
  }));
  if (route?.workSlug) {
    const match = findStoryboardForRoute({
      projectId: startupParams.get('project'),
      workSlug: route.workSlug,
    });
    if (match && match.id !== getCurrentStoryboardRecord()?.id) {
      await openStoryboard(match.id, els);
    }
  }
  storyboardController.renderPicker();
  const loaded = await loadStoryboardIntoUI();
  scriptController?.syncRoute?.();
  initWorkbar({
    session,
    getRecord: getCurrentStoryboardRecord,
    manageShare: true,
    onShareStatus: (message) => setStatus(message),
  });

  if (startupParams.get('download') === '1') {
    els.downloadZipBtn.click();
    startupParams.delete('download');
    const query = startupParams.toString();
    history.replaceState(history.state, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
  }

  if (restored && loaded) setStatus('Ready. Saved.');
}

const isTestPage = window.location.pathname === '/test.html' || window.location.pathname === '/test';
if (!isTestPage) {
  init().catch(err => {
    console.error("Failed to init app:", err);
    setStatus("Failed to initialize app.");
  });
}
