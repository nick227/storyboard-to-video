import { sceneStore, generationStore, uiStore, projectStore, debounce } from '../core/store.js';
import {
  splitSceneInPlace,
  invalidateVideoMotion,
  regeneratePrompt,
  regenerateAction,
  regenerateDialogue,
  regenerateImage,
  regenerateAudio,
  regenerateVideo,
  regenerateSubtitles,
} from '../generation/workflows.js';
import { renderCaptionInto } from '../media/subtitle-overlay.js';
import { ensureProjectSynced, getCurrentStoryboardRecord } from '../core/persistence.js';
import { api } from '../core/api.js';
import { suggestSceneCountFromNarration } from '../generation/scene-count.js';
import { computeStaleness, resolveSelectedSceneIndex, getCachedJobs, refreshRecentJobs, refreshSpend, buildLatestJobsByScene } from '../generation/stages.js';
import { imageShot } from '../core/scene-shots.js';
import { REFERENCE_ROLES, REFERENCE_ROLE_LABELS, normalizeReferenceRole } from '../core/reference-roles.js';
import {
  SCENE_ENTITY_TYPES,
  SCENE_ENTITY_LABELS,
  clearEntityOverride,
  hasEntityOverride,
  resolvedEntityConfig,
  setEntityOverride,
} from '../core/scene-entity-config.js';
import {
  closeSceneAudioRecorder, openSceneAudioRecorder, previewSceneAudioRecording,
  retakeSceneAudioRecording, setSceneAudioMonitoring, setSceneAudioNoiseSuppression,
  submitSceneAudioRecording, switchSceneAudioMicrophone,
  toggleSceneAudioRecording,
} from '../media/scene-audio-recorder.js';

// Extracted seams imports
import {
  bindProtectedAsset,
  setupScenePlayback,
  pauseActiveScenePlayback,
  handleAssetError,
  setElementProtectedAsset,
} from './media/protected-media-binding.js';

/** @deprecated Import from protected-media-binding.js */
export { setupScenePlayback };

import {
  replaceScene,
  updateScene,
  updateSceneById,
  applySceneConfigOverride,
  clearSceneConfigOverride,
  selectSceneEntityVersion,
  applyVideoKeyframes,
  replaceSceneFromServer,
  toggleDefaultReference,
} from './scene-controller/scene-actions.js';

import { ENTITY_CONFIG } from './scene-controller/entity-registry.js';

import {
  isEntityLoading,
  hasExistingEntity,
  sceneFreshnessByType,
  entityStatuses,
  sceneStatusSummary,
} from './scene-controller/entity-status.js';

let els = {};
let scenePlaybackCleanups = new Map();

function runGenerationWorkflow(type, index, domEls, cb, instruction = '') {
  switch (type) {
    case 'action':
      return regenerateAction(index, domEls, cb);
    case 'prompt':
      return regeneratePrompt(index, domEls, cb);
    case 'dialogue':
      return regenerateDialogue(index, domEls, cb, instruction);
    case 'image':
      return regenerateImage(index, null, domEls, cb).catch((error) => cb(error.message));
    case 'audio':
      return regenerateAudio(index, null, domEls, cb).catch((error) => cb(error.message));
    case 'video':
      return regenerateVideo(index, null, domEls, cb).catch((error) => cb(error.message));
    case 'subtitle':
      return regenerateSubtitles(index, null, domEls, cb).catch((error) => cb(error.message));
    default:
      return Promise.reject(new Error(`Unknown entity type: ${type}`));
  }
}

export function renderEntityOperationState() {
  const busy = Boolean(uiStore.get().operation);
  els.sceneUploadedReferences?.querySelectorAll('.ref-delete-btn').forEach((button) => { button.disabled = busy; });
  els.entityModalHistoryList?.querySelectorAll('.version-thumb').forEach((button) => { button.disabled = busy; });
  els.entityModalHistoryList?.querySelectorAll('.audio-version-select').forEach((button) => {
    button.disabled = busy || button.classList.contains('is-current');
  });
}

const modalState = {
  confirmResolve: null,
  sceneId: null,
  type: null,
  mediaPath: undefined,
  historyAbortController: null,
  mediaAbortController: null,
  alignmentWords: [],
  captionTarget: null,
  confirmApply: null,
  configType: null,
};

const referenceModalState = { sceneId: null };
const MISSING_ENTITY_STATUS = Object.freeze({ key: 'missing', label: 'Never generated' });

function configDescription(type, config) {
  const values = [];
  if (config.provider) values.push(String(config.provider));
  if (config.model) values.push(String(config.model));
  if (type === 'audio' && config.voice) {
    const voiceLabel = typeof config.voice === 'object' ? (config.voice.label || config.voice.voiceId) : config.voice;
    if (voiceLabel) values.push(`Voice: ${voiceLabel}`);
  }
  if (config.aspectRatio) values.push(config.aspectRatio);
  if (config.resolutionTier) values.push(config.resolutionTier);
  if (config.quality) values.push(config.quality);
  if (config.durationSeconds) values.push(`${config.durationSeconds}s`);
  if (config.motionIntensity) values.push(`${config.motionIntensity} motion`);
  if (config.style) values.push(`${config.style} style`);
  return values.length ? values.join(' · ') : 'Project generation settings';
}

function setupConfirmModal() {
  const modal = els.confirmRegenModal;
  if (!modal || modal.dataset.wired) return;
  modal.dataset.wired = 'true';
  els.confirmRegenCancelBtn.addEventListener('click', () => modal.close());
  els.confirmRegenConfirmBtn.addEventListener('click', () => modal.close('confirm'));
  modal.addEventListener('click', (event) => { if (event.target === modal) modal.close(); });
  modal.addEventListener('close', () => {
    const confirmed = modal.returnValue === 'confirm';
    modal.returnValue = '';
    const apply = modalState.confirmApply;
    modalState.confirmApply = null;
    if (confirmed && apply) apply();
    const resolve = modalState.confirmResolve;
    modalState.confirmResolve = null;
    if (resolve) resolve(confirmed);
  });
}

const VIDEO_PROVIDER_LABELS = Object.freeze({ ltx: 'LTX (local)', minimax: 'MiniMax', veo: 'Veo', stub: 'Stub Preview (no API)' });

function selectedOptionLabel(select, fallback = '') {
  return select?.selectedOptions?.[0]?.textContent?.trim() || select?.value || fallback;
}

export function regenerationProviderSelection(type, domEls, scene = null) {
  const selections = {
    prompt: { kind: 'LLM provider', select: domEls.textProvider },
    action: { kind: 'LLM provider', select: domEls.textProvider },
    dialogue: { kind: 'LLM provider', select: domEls.textProvider },
    image: { kind: 'Image provider', select: domEls.imageProvider },
    audio: { kind: 'Audio provider', select: domEls.audioProvider },
    video: { kind: 'Video provider', select: domEls.videoProvider, fallback: 'Platform default' },
  };
  const selection = selections[type];
  if (!selection) return null;

  let label = '';
  const overrideProvider = scene?.entityOverrides?.[type]?.provider;
  if (overrideProvider && selection.select) {
    const option = Array.from(selection.select.options).find((opt) => opt.value === overrideProvider);
    label = option ? (option.textContent?.trim() || '') : overrideProvider.replace(/^./, (letter) => letter.toUpperCase());
  } else {
    label = selectedOptionLabel(selection.select, selection.fallback);
  }

  return { kind: selection.kind, label };
}

function configureRegenerationProvider(type, scene = null) {
  const selection = regenerationProviderSelection(type, els, scene);
  if (!els.confirmVideoSummary) return;
  els.confirmVideoSummary.hidden = !selection;
  if (!selection) return;
  els.confirmRegenProviderKindLabel.textContent = selection.kind;
  els.confirmVideoProviderLabel.textContent = selection.label;
  els.confirmVideoBeatRow.hidden = true;
  els.confirmVideoPromptRow.hidden = true;
}

function goToImageGeneration(sceneIndex) {
  els.confirmRegenModal.close();
  openEntityModal(sceneIndex, 'image');
}

function configureVideoKeyframeConfirmation(scene, sceneIndex) {
  const record = getCurrentStoryboardRecord();
  const providerName = els.videoProvider?.value || record?.mediaSettings?.video?.provider || '';
  const shot = imageShot(scene);
  const versions = (shot.versions || []).filter((version) => Boolean(version?.path));

  if (els.confirmVideoSummary) {
    els.confirmVideoSummary.hidden = false;
    els.confirmRegenProviderKindLabel.textContent = 'Video provider';
    els.confirmVideoProviderLabel.textContent = providerName ? (VIDEO_PROVIDER_LABELS[providerName] || providerName) : 'Platform default';
    els.confirmVideoBeatRow.hidden = false;
    els.confirmVideoPromptRow.hidden = false;
    els.confirmVideoBeatLabel.textContent = scene.beat?.trim() || '—';
    els.confirmVideoPromptLabel.textContent = shot.prompt?.trim() || '—';
  }

  const supportsKeyframes = providerName === 'minimax';
  const available = supportsKeyframes && versions.length > 1;
  els.confirmVideoKeyframes.hidden = !available;
  if (els.confirmVideoNeedsImageNote) {
    els.confirmVideoNeedsImageNote.hidden = !(supportsKeyframes && versions.length <= 1);
    els.confirmVideoNeedsImageBtn.onclick = () => goToImageGeneration(sceneIndex);
  }
  modalState.confirmApply = null;
  if (!available) return;

  if (els.confirmVideoGenerateImageBtn) els.confirmVideoGenerateImageBtn.onclick = () => goToImageGeneration(sceneIndex);

  const selected = shot.videoKeyframeSelection?.source === 'video_generation_confirmation'
    ? shot.videoKeyframeSelection
    : null;
  const active = shot.versions?.[shot.activeVersionIndex]?.path || versions[0].path;
  const option = (version, index) => {
    const item = document.createElement('option');
    item.value = version.path;
    item.textContent = `Image version ${index + 1}${version.path === active ? ' (active)' : ''}`;
    return item;
  };
  els.confirmVideoStartFrame.replaceChildren(...versions.map(option));
  const noEnd = document.createElement('option');
  noEnd.value = '';
  noEnd.textContent = 'No end keyframe — animate from the start image';
  els.confirmVideoEndFrame.replaceChildren(noEnd, ...versions.map(option));
  els.confirmVideoStartFrame.value = versions.some((version) => version.path === selected?.startFrame) ? selected.startFrame : active;
  els.confirmVideoEndFrame.value = versions.some((version) => version.path === selected?.endFrame) ? selected.endFrame : '';
  els.confirmVideoKeyframesDetails.open = Boolean(els.confirmVideoEndFrame.value);

  const selectedVersion = (path) => versions.find((version) => version.path === path) || null;
  const referenceLineage = (version) => JSON.stringify((version?.manifest?.inputs?.references || [])
    .filter((reference) => reference.consumed !== false)
    .map((reference) => ({ role: reference.role || '', path: reference.path || '' }))
    .sort((a, b) => `${a.role}:${a.path}`.localeCompare(`${b.role}:${b.path}`)));
  const showPreview = (element, assetPath) => {
    element.hidden = !assetPath;
    bindProtectedAsset(element, assetPath);
  };
  const refresh = () => {
    const start = els.confirmVideoStartFrame.value;
    for (const item of els.confirmVideoEndFrame.options) item.disabled = Boolean(item.value && item.value === start);
    if (els.confirmVideoEndFrame.value === start) els.confirmVideoEndFrame.value = '';
    const end = els.confirmVideoEndFrame.value;
    showPreview(els.confirmVideoStartPreview, start);
    showPreview(els.confirmVideoEndPreview, end);
    els.confirmVideoEndPreviewEmpty.hidden = Boolean(end);
    const startVersion = selectedVersion(start);
    const endVersion = selectedVersion(end);
    const warnings = [];
    if (end && referenceLineage(startVersion) !== referenceLineage(endVersion)) warnings.push('The two images were generated with different character/world reference lineages; consistency may be reduced.');
    if (computeStaleness(scene).imageStale && start === active) warnings.push('The active start image is stale relative to the current scene settings.');
    els.confirmVideoKeyframeStatus.textContent = [
      end ? 'Interpolation enabled: MiniMax will use exactly these two generated scene images.' : 'Start-frame animation only. No final image will be attached.',
      ...warnings,
    ].join(' ');
  };
  els.confirmVideoStartFrame.onchange = refresh;
  els.confirmVideoEndFrame.onchange = refresh;
  refresh();

  modalState.confirmApply = () => {
    applyVideoKeyframes(sceneIndex, els.confirmVideoStartFrame.value, els.confirmVideoEndFrame.value || null);
  };
}

function confirmRegeneration(message, confirmLabel = 'Regenerate', options = {}) {
  return new Promise((resolve) => {
    modalState.confirmResolve = resolve;
    modalState.confirmApply = null;
    if (els.confirmVideoKeyframes) els.confirmVideoKeyframes.hidden = true;
    if (els.confirmVideoSummary) els.confirmVideoSummary.hidden = true;
    if (els.confirmVideoNeedsImageNote) els.confirmVideoNeedsImageNote.hidden = true;
    const sceneIndex = currentEntityModalSceneIndex();
    const scene = options.videoScene || (sceneIndex !== -1 ? sceneStore.get().scenes[sceneIndex] : null);
    configureRegenerationProvider(options.entityType, scene);
    if (options.videoScene) configureVideoKeyframeConfirmation(options.videoScene, options.sceneIndex);
    els.confirmRegenMessage.textContent = message;
    els.confirmRegenConfirmBtn.textContent = confirmLabel;
    els.confirmRegenModal.showModal();
  });
}

// Every single-scene regenerate call in this module resolves regardless of outcome — workflows.js's
// prompt/action/dialogue functions catch their own errors internally (never reject), and image/
// audio/video's rejections are caught by ENTITY_CONFIG's own .catch() wrapper — so this can run
// unconditionally after any of them settle. It exists specifically for the failure case: a failed
// attempt never touches sceneStore (nothing to reactively re-render off of), so without an explicit
// jobs refresh + re-render here, a failed generation leaves the status icon looking exactly like
// "never attempted" until something unrelated happens to trigger a later refresh.
function refreshJobsAndRerenderScenes() {
  const projectId = projectStore.get().currentId;
  return Promise.all([refreshRecentJobs(projectId), refreshSpend(projectId)]).then(() => renderScenes());
}

function currentEntityModalSceneIndex() {
  if (!modalState.sceneId) return -1;
  return sceneStore.get().scenes.findIndex((s) => s.id === modalState.sceneId);
}

function openEntityModal(index, type = null) {
  const scene = sceneStore.get().scenes[index];
  if (!scene || (type && !ENTITY_CONFIG[type])) return;
  modalState.sceneId = scene.id;
  modalState.type = type;
  modalState.configType = null;
  modalState.mediaPath = undefined;
  closeSceneAudioRecorder(els);
  els.entityModal.showModal();
  renderEntityModal();
}

function currentReferenceSceneIndex() {
  return sceneStore.get().scenes.findIndex((scene) => scene.id === referenceModalState.sceneId);
}

function referenceEmpty(text) {
  const empty = document.createElement('div');
  empty.className = 'scene-reference-empty';
  empty.textContent = text;
  return empty;
}

function referenceImage(url, alt) {
  const image = document.createElement('img');
  image.alt = alt;
  image.loading = 'lazy';
  loadProtectedAsset(url).then((src) => { if (src) image.src = src; }).catch(handleAssetError);
  return image;
}

function renderSceneReferencesModal() {
  if (!els.sceneReferencesModal?.open) return;
  const index = currentReferenceSceneIndex();
  if (index === -1) { els.sceneReferencesModal.close(); return; }
  const scene = sceneStore.get().scenes[index];
  const shot = imageShot(scene);
  const disabled = new Set(shot.disabledStyleReferencePaths || []);
  const defaults = Object.values(generationStore.get().styleReferences || {}).flat();
  const uploaded = shot.referenceBindings || [];
  els.sceneReferencesModalSceneLabel.textContent = `${scene.title || 'Untitled'}`;
  els.sceneDefaultReferences.replaceChildren();
  els.sceneUploadedReferences.replaceChildren();

  if (!defaults.length) els.sceneDefaultReferences.appendChild(referenceEmpty('No project default references are configured for the selected style.'));
  defaults.forEach((item) => {
    const card = document.createElement('div');
    const isEnabled = !disabled.has(item.url);
    card.className = `scene-reference-item${isEnabled ? '' : ' is-disabled'}`;
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.checked = isEnabled; checkbox.dataset.defaultReference = item.url;
    const name = document.createElement('span'); name.textContent = item.fileName;
    label.append(checkbox, name);
    card.append(referenceImage(item.url, item.fileName), label);
    els.sceneDefaultReferences.appendChild(card);
  });

  if (!uploaded.length) els.sceneUploadedReferences.appendChild(referenceEmpty('No scene-only references uploaded.'));
  uploaded.forEach((item) => {
    const card = document.createElement('div'); card.className = 'scene-reference-item';
    const name = document.createElement('div'); name.className = 'scene-reference-name';
    const text = document.createElement('span'); text.textContent = item.fileName || 'Scene reference';
    const role = document.createElement('select'); role.className = 'scene-reference-role'; role.dataset.sceneReferenceRole = item.path;
    role.setAttribute('aria-label', `Role for ${item.fileName || 'scene reference'}`);
    for (const value of REFERENCE_ROLES) {
      const option = document.createElement('option'); option.value = value; option.textContent = REFERENCE_ROLE_LABELS[value]; role.appendChild(option);
    }
    role.value = normalizeReferenceRole(item.role);
    name.append(text, role);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'ref-delete-btn'; remove.textContent = '×';
    remove.dataset.sceneReferencePath = item.path; remove.setAttribute('aria-label', `Delete ${item.fileName || 'scene reference'}`);
    card.append(referenceImage(item.path, item.fileName || 'Scene reference'), name, remove);
    els.sceneUploadedReferences.appendChild(card);
  });
  els.sceneReferenceInput.disabled = uploaded.length >= 8;
  renderEntityOperationState();
}

function setupSceneReferencesModal() {
  const modal = els.sceneReferencesModal;
  if (!modal || modal.dataset.wired) return;
  modal.dataset.wired = 'true';
  modal.querySelectorAll('[data-close-scene-references]').forEach((button) => button.addEventListener('click', () => modal.close()));
  modal.addEventListener('click', (event) => { if (event.target === modal) modal.close(); });
  modal.addEventListener('close', () => { referenceModalState.sceneId = null; els.sceneReferenceInput.value = ''; });

  els.sceneDefaultReferences.addEventListener('change', (event) => {
    const checkbox = event.target.closest('[data-default-reference]');
    const index = currentReferenceSceneIndex();
    if (!checkbox || index === -1) return;
    const url = checkbox.dataset.defaultReference;
    toggleDefaultReference(index, url, checkbox.checked, (text) => { els.sceneReferencesSaveNote.textContent = text; });
  });

  els.sceneReferenceInput.addEventListener('change', async (event) => {
    const files = event.target.files;
    const index = currentReferenceSceneIndex();
    if (!files?.length || index === -1) return;
    const scene = sceneStore.get().scenes[index];
    const record = getCurrentStoryboardRecord();
    try {
      modal.setAttribute('aria-busy', 'true'); els.sceneReferencesSaveNote.textContent = 'Uploading…';
      await ensureProjectSynced();
      const form = new FormData(); [...files].forEach((file) => form.append('files', file));
      const data = await api(`/api/projects/${encodeURIComponent(record.id)}/scenes/${encodeURIComponent(scene.id)}/references`, { method: 'POST', body: form });
      replaceSceneFromServer(data); els.sceneReferencesSaveNote.textContent = 'Uploaded';
    } catch (error) { els.sceneReferencesSaveNote.textContent = `Upload failed: ${error.message}`; }
    finally { modal.removeAttribute('aria-busy'); event.target.value = ''; renderSceneReferencesModal(); }
  });

  els.sceneUploadedReferences.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-scene-reference-path]');
    const index = currentReferenceSceneIndex();
    if (!button || index === -1) return;
    const scene = sceneStore.get().scenes[index]; const record = getCurrentStoryboardRecord();
    try {
      modal.setAttribute('aria-busy', 'true'); els.sceneReferencesSaveNote.textContent = 'Deleting…';
      await ensureProjectSynced();
      const data = await api(`/api/projects/${encodeURIComponent(record.id)}/scenes/${encodeURIComponent(scene.id)}/references`, { method: 'DELETE', body: JSON.stringify({ path: button.dataset.sceneReferencePath }) });
      replaceSceneFromServer(data); els.sceneReferencesSaveNote.textContent = 'Deleted';
    } catch (error) { els.sceneReferencesSaveNote.textContent = `Delete failed: ${error.message}`; }
    finally { modal.removeAttribute('aria-busy'); renderSceneReferencesModal(); }
  });

  els.sceneUploadedReferences.addEventListener('change', async (event) => {
    const select = event.target.closest('[data-scene-reference-role]');
    const index = currentReferenceSceneIndex();
    if (!select || index === -1) return;
    const scene = sceneStore.get().scenes[index]; const record = getCurrentStoryboardRecord();
    try {
      modal.setAttribute('aria-busy', 'true'); els.sceneReferencesSaveNote.textContent = 'Saving role…';
      await ensureProjectSynced();
      const data = await api(`/api/projects/${encodeURIComponent(record.id)}/scenes/${encodeURIComponent(scene.id)}/references/role`, {
        method: 'PATCH',
        body: JSON.stringify({ path: select.dataset.sceneReferenceRole, role: select.value }),
      });
      replaceSceneFromServer(data); els.sceneReferencesSaveNote.textContent = 'Role saved';
    } catch (error) { els.sceneReferencesSaveNote.textContent = `Role update failed: ${error.message}`; }
    finally { modal.removeAttribute('aria-busy'); renderSceneReferencesModal(); }
  });
}

function openSceneReferencesModal(index) {
  const scene = sceneStore.get().scenes[index];
  if (!scene) return;
  referenceModalState.sceneId = scene.id;
  els.sceneReferencesSaveNote.textContent = 'Changes apply to this scene';
  els.sceneReferencesModal.showModal();
  renderSceneReferencesModal();
}

function renderEntityModalMedia(scene, type, config) {
  const versions = config.versions(scene);
  const active = versions?.[config.activeIndex(scene)];
  const path = active?.path || null;
  els.entityModalMediaEmpty.hidden = Boolean(path);

  if (els.entityModalMediaMeta) {
    if (active) {
      const providerName = active.provider ? String(active.provider).replace(/^./, (letter) => letter.toUpperCase()) : '';
      const styleId = active.manifest?.inputs?.style?.id || active.styleId;
      const styleObj = styleId ? generationStore.get().styles.find((s) => s.id === styleId) : null;
      const styleName = active.manifest?.inputs?.style?.name || styleObj?.name || '';
      
      const parts = [];
      if (styleName) parts.push(`Style: <strong>${styleName}</strong>`);
      if (providerName) parts.push(`Provider: <strong>${providerName}</strong>`);
      if (active.manifest?.inputs?.provider?.model) parts.push(`Model: <strong>${active.manifest.inputs.provider.model}</strong>`);
      
      const ar = active.output?.requested?.aspectRatio || active.manifest?.inputs?.settings?.output?.requested?.aspectRatio;
      if (ar) parts.push(`Aspect Ratio: <strong>${ar}</strong>`);
      
      els.entityModalMediaMeta.innerHTML = parts.join(' · ');
      els.entityModalMediaMeta.hidden = false;
    } else {
      els.entityModalMediaMeta.textContent = '';
      els.entityModalMediaMeta.hidden = true;
    }
  }

  if (path === modalState.mediaPath) return; // unchanged — don't disrupt any in-progress playback
  modalState.mediaPath = path;

  els.entityModalImage.hidden = true;
  els.entityModalVideo.hidden = true;
  els.entityModalAudio.hidden = true;
  els.entityModalImage.removeAttribute('src');
  els.entityModalVideo.pause();
  els.entityModalVideo.removeAttribute('src');
  els.entityModalVideo.load();
  els.entityModalAudio.pause();
  els.entityModalAudio.removeAttribute('src');
  els.entityModalAudio.load();
  modalState.alignmentWords = [];
  modalState.captionTarget = null;
  els.entityModalAudioCaption.hidden = true;
  els.entityModalAudioCaption.textContent = '';
  els.entityModalSubtitleOverlay.hidden = true;
  els.entityModalSubtitleOverlay.textContent = '';

  if (!path) return;

  modalState.mediaAbortController?.abort();
  modalState.mediaAbortController = new AbortController();
  const signal = modalState.mediaAbortController.signal;

  const guard = () => modalState.mediaPath === path;
  if (type === 'image') {
    bindProtectedAsset(els.entityModalImage, path, { signal, extraGuard: guard });
    els.entityModalImage.hidden = false;
  } else if (type === 'video') {
    bindProtectedAsset(els.entityModalVideo, path, { signal, extraGuard: guard });
    els.entityModalVideo.hidden = false;
  } else if (type === 'audio') {
    bindProtectedAsset(els.entityModalAudio, path, { signal, extraGuard: guard });
    els.entityModalAudio.hidden = false;
    const words = active?.alignment?.words || [];
    modalState.alignmentWords = words;
    modalState.captionTarget = els.entityModalAudioCaption;
    renderCaptionInto(els.entityModalAudioCaption, words, 0);
  } else if (type === 'subtitle') {
    const shot = imageShot(scene);
    const visualVersions = scene.activeVisualType === 'video' ? shot.videoVersions : shot.versions;
    const visualIndex = scene.activeVisualType === 'video' ? shot.activeVideoVersionIndex : shot.activeVersionIndex;
    const visualPath = visualVersions?.[visualIndex]?.path || null;
    const visualEl = scene.activeVisualType === 'video' ? els.entityModalVideo : els.entityModalImage;
    if (visualPath) {
      bindProtectedAsset(visualEl, visualPath, { signal, extraGuard: guard });
      visualEl.hidden = false;
    }
    const audioPath = active?.sourceAudioPath || null;
    if (audioPath) {
      bindProtectedAsset(els.entityModalAudio, audioPath, { signal, extraGuard: guard });
      els.entityModalAudio.hidden = false;
    }
    const words = active?.words || [];
    modalState.alignmentWords = words;
    modalState.captionTarget = els.entityModalSubtitleOverlay;
    els.entityModalSubtitleOverlay.dataset.captionStyle = active?.style || 'classic';
    renderCaptionInto(els.entityModalSubtitleOverlay, words, 0);
  }
}

function renderEntityModalHistory(scene, type, config, busy) {
  if (config.kind === 'text') { els.entityModalHistory.hidden = true; return; }
  const versions = config.versions(scene);
  const activeIdx = config.activeIndex(scene);
  els.entityModalHistory.hidden = versions.length === 0;
  els.entityModalHistoryCount.textContent = `${versions.length} version${versions.length === 1 ? '' : 's'}`;
  els.entityModalHistoryList.className = type === 'audio' || type === 'subtitle' ? 'audio-version-list' : 'version-list';
  els.entityModalHistoryList.innerHTML = '';
  modalState.historyAbortController?.abort();
  modalState.historyAbortController = new AbortController();
  const signal = modalState.historyAbortController.signal;

  if (type === 'subtitle') {
    // Text-only history row -- a subtitle version has no visual/audio asset of its own to preview
    // (just timing data), so there's no thumbnail/player, unlike every other kind's history entry.
    versions.forEach((version, vIndex) => {
      const thumb = document.createElement('div');
      thumb.className = `audio-version-thumb ${vIndex === activeIdx ? 'active' : ''}`;
      const meta = document.createElement('div');
      meta.className = 'audio-version-meta';
      const label = document.createElement('strong');
      label.textContent = `Version ${vIndex + 1}`;
      const detail = document.createElement('span');
      const cueCount = version.cues?.length || 0;
      detail.textContent = `${cueCount} cue${cueCount === 1 ? '' : 's'} · ${version.style || 'classic'}`;
      meta.append(label, detail);
      const selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'audio-version-select';
      selectBtn.dataset.vindex = String(vIndex);
      selectBtn.textContent = vIndex === activeIdx ? 'Current' : 'Use this version';
      selectBtn.classList.toggle('is-current', vIndex === activeIdx);
      selectBtn.disabled = busy || vIndex === activeIdx;
      thumb.append(meta, selectBtn);
      els.entityModalHistoryList.appendChild(thumb);
    });
    return;
  }

  if (type === 'audio') {
    versions.forEach((version, vIndex) => {
      const thumb = document.createElement('div');
      thumb.className = `audio-version-thumb ${vIndex === activeIdx ? 'active' : ''}`;
      const meta = document.createElement('div');
      meta.className = 'audio-version-meta';
      const label = document.createElement('strong');
      label.textContent = `Version ${vIndex + 1}`;
      const provider = document.createElement('span');
      provider.textContent = version.provider || 'Audio';
      meta.append(label, provider);
      const audio = document.createElement('audio');
      audio.controls = true;
      bindProtectedAsset(audio, version.path, { signal });
      const selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'audio-version-select';
      selectBtn.dataset.vindex = String(vIndex);
      selectBtn.textContent = vIndex === activeIdx ? 'Current' : 'Use this version';
      selectBtn.classList.toggle('is-current', vIndex === activeIdx);
      selectBtn.disabled = busy || vIndex === activeIdx;
      thumb.append(meta, audio, selectBtn);
      els.entityModalHistoryList.appendChild(thumb);
    });
    return;
  }

  versions.forEach((version, vIndex) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `version-thumb ${vIndex === activeIdx ? 'active' : ''}`;
    btn.dataset.vindex = String(vIndex);
    btn.disabled = busy;
    let mediaEl;
    if (type === 'video') {
      mediaEl = document.createElement('video');
      mediaEl.muted = true;
      mediaEl.preload = 'metadata';
      mediaEl.style.cssText = 'display:block;width:100%;height:72px;object-fit:cover';
    } else {
      mediaEl = document.createElement('img');
      mediaEl.alt = `Scene version ${vIndex + 1}`;
    }
    bindProtectedAsset(mediaEl, version.path, { signal });
    const meta = document.createElement('div');
    meta.className = 'version-meta';
    const providerName = version.provider ? String(version.provider).replace(/^./, (letter) => letter.toUpperCase()) : '';
    const styleId = version.manifest?.inputs?.style?.id || version.styleId;
    const styleObj = styleId ? generationStore.get().styles.find((s) => s.id === styleId) : null;
    const styleName = version.manifest?.inputs?.style?.name || styleObj?.name || '';
    meta.textContent = `v${vIndex + 1}${providerName ? ` · ${providerName}` : ''}${styleName ? ` · ${styleName}` : ''}`;
    btn.append(mediaEl, meta);

    els.entityModalHistoryList.appendChild(btn);
  });
}

function rowMediaPreview(scene, type) {
  const container = document.createElement('div');
  container.className = 'entity-row-media';
  const config = ENTITY_CONFIG[type];
  const versions = config.versions(scene) || [];
  const active = versions[config.activeIndex(scene)];
  const path = active?.path;

  if (!path) {
    const empty = document.createElement('span');
    empty.className = 'entity-row-media-empty';
    empty.textContent = 'No media yet';
    container.appendChild(empty);
    return container;
  }

  let media;
  if (type === 'audio') {
    media = document.createElement('audio');
    media.controls = true;
    media.preload = 'metadata';
  } else if (type === 'video') {
    media = document.createElement('video');
    media.muted = true;
    media.playsInline = true;
    media.preload = 'metadata';
  } else if (type === 'subtitle') {
    const shot = imageShot(scene);
    const visual = scene.activeVisualType === 'video'
      ? shot.videoVersions?.[shot.activeVideoVersionIndex]
      : shot.versions?.[shot.activeVersionIndex];
    media = document.createElement(scene.activeVisualType === 'video' ? 'video' : 'img');
    path && (media.dataset.subtitlePath = path);
    bindProtectedAsset(media, visual?.path);
    const caption = document.createElement('span');
    caption.className = 'entity-row-caption-preview';
    caption.textContent = `${active.cues?.length || active.words?.length || 0} timed captions`;
    container.append(media, caption);
    return container;
  } else {
    media = document.createElement('img');
    media.alt = `${SCENE_ENTITY_LABELS[type]} preview`;
  }
  bindProtectedAsset(media, path);
  container.appendChild(media);
  return container;
}

function configFieldSource(type, key) {
  if (key === 'provider') {
    if (['action', 'prompt', 'dialogue'].includes(type)) return els.textProvider;
    if (type === 'image') return els.imageProvider;
    if (type === 'audio') return els.audioProvider;
    if (type === 'video') return els.videoProvider;
  }
  const sources = {
    aspectRatio: els.mediaAspectRatio,
    resolutionTier: type === 'image' ? els.imageResolutionTier : els.videoResolutionTier,
    quality: els.imageQuality,
    durationSeconds: els.videoDurationSeconds,
    motionIntensity: els.videoMotionIntensity,
    style: els.subtitleStyleSelect,
  };
  return sources[key] || null;
}

function configEditor(scene, type, config) {
  const editor = document.createElement('div');
  editor.className = 'entity-config-editor';
  editor.dataset.configEditor = type;
  const heading = document.createElement('strong');
  heading.textContent = `${SCENE_ENTITY_LABELS[type]} settings · this scene only`;
  editor.appendChild(heading);

  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) continue;
    const label = document.createElement('label');
    label.className = 'entity-config-field';
    const title = document.createElement('span');
    title.textContent = key.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase());
    const source = configFieldSource(type, key);
    let control;
    if (source?.tagName === 'SELECT') {
      control = document.createElement('select');
      for (const option of source.options) control.appendChild(option.cloneNode(true));
    } else {
      control = document.createElement('input');
      control.type = typeof value === 'number' ? 'number' : 'text';
    }
    control.name = key;
    control.value = value ?? '';
    label.append(title, control);
    editor.appendChild(label);
  }

  const actions = document.createElement('div');
  actions.className = 'entity-config-actions';
  const useDefault = document.createElement('button');
  useDefault.type = 'button';
  useDefault.className = 'secondary';
  useDefault.dataset.entityUseDefault = type;
  useDefault.textContent = 'Use project default';
  useDefault.disabled = !hasEntityOverride(scene, type);
  const editDefaults = document.createElement('button');
  editDefaults.type = 'button';
  editDefaults.className = 'secondary';
  editDefaults.dataset.entityEditDefaults = type;
  editDefaults.textContent = 'Edit project defaults';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'secondary';
  cancel.dataset.entityConfigCancel = type;
  cancel.textContent = 'Cancel';
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'primary';
  apply.dataset.entityConfigApply = type;
  apply.textContent = 'Apply to this scene';
  actions.append(useDefault, editDefaults, cancel, apply);
  editor.appendChild(actions);
  return editor;
}

function entityControllerRow(scene, status) {
  const type = status.type;
  const config = ENTITY_CONFIG[type];
  const row = document.createElement('section');
  row.className = `entity-controller-row status-${status.key}`;
  row.dataset.entityType = type;

  const heading = document.createElement('div');
  heading.className = 'entity-row-heading';
  const title = document.createElement('strong');
  title.textContent = SCENE_ENTITY_LABELS[type];
  const badge = document.createElement('span');
  badge.className = `entity-status-badge status-${status.key}`;
  badge.textContent = status.label;
  heading.append(title, badge);

  const body = document.createElement('div');
  body.className = 'entity-row-body';
  const content = document.createElement('div');
  content.className = 'entity-row-content';
  if (config.kind === 'text') {
    const textarea = document.createElement('textarea');
    textarea.className = 'entity-row-textarea';
    textarea.dataset.entityText = type;
    textarea.value = config.getValue(scene) || '';
    textarea.placeholder = `${SCENE_ENTITY_LABELS[type]} has not been generated`;
    content.appendChild(textarea);
  } else {
    content.appendChild(rowMediaPreview(scene, type));
  }

  const meta = document.createElement('div');
  meta.className = 'entity-row-meta';
  const description = document.createElement('span');
  description.textContent = configDescription(type, status.config);
  const scope = document.createElement('span');
  scope.textContent = ` · ${hasEntityOverride(scene, type) ? 'Scene override' : 'Project default'} · `;
  const change = document.createElement('button');
  change.type = 'button';
  change.className = 'secondary entity-change-btn';
  change.dataset.entityConfig = type;
  change.textContent = 'Change…';
  meta.append(description, scope, change);
  if (status.reason) {
    const reason = document.createElement('span');
    reason.className = 'entity-status-reason';
    reason.textContent = status.reason;
    meta.appendChild(reason);
  }
  content.appendChild(meta);

  const controls = document.createElement('div');
  controls.className = 'entity-row-controls';
  const generate = document.createElement('button');
  generate.type = 'button';
  generate.className = 'primary entity-primary-action';
  generate.dataset.entityGenerate = type;
  generate.textContent = status.loading ? 'Generating…' : 'Generate';
  generate.disabled = Boolean(uiStore.get().operation);
  controls.appendChild(generate);
  body.append(content, controls);
  row.append(heading, body);
  if (modalState.configType === type) row.appendChild(configEditor(scene, type, status.config));
  return row;
}

function renderSceneController() {
  if (!els.entityModal?.open) return;
  const index = currentEntityModalSceneIndex();
  if (index === -1) { els.entityModal.close(); return; }
  const scene = sceneStore.get().scenes[index];
  const statuses = entityStatuses(scene, uiStore.get().operation);
  els.entityModalSceneLabel.textContent = `Scene ${index + 1}`;
  els.entityModalTitle.textContent = scene.title || `Scene ${index + 1}`;
  els.entityModalSummary.textContent = sceneStatusSummary(statuses);
  els.entityModalPosition.textContent = `${index + 1} of ${sceneStore.get().scenes.length}`;
  els.entityModalPreviousBtn.disabled = index === 0;
  els.entityModalNextBtn.disabled = index === sceneStore.get().scenes.length - 1;
  els.entityModalSourceText.textContent = scene.sourceScriptFragment || scene.scriptFragment || 'No source fragment';
  els.entityControllerRows.replaceChildren(...SCENE_ENTITY_TYPES.map((type) => entityControllerRow(scene, statuses[type])));
  els.entityModalDeleteBtn.disabled = Boolean(uiStore.get().operation);
}

function renderEntityDetail() {
  if (!modalState.type || !els.entityModal.open) return;
  const index = currentEntityModalSceneIndex();
  if (index === -1) { els.entityModal.close(); return; }
  const scene = sceneStore.get().scenes[index];
  const type = modalState.type;
  const config = ENTITY_CONFIG[type];
  const operation = uiStore.get().operation;
  const busy = operation != null;
  const recorderOpen = !els.sceneAudioRecorder.hidden;
  const controlsBusy = busy || recorderOpen;
  const isLoading = isEntityLoading(type, scene, operation);

  els.entityModalDetailTitle.textContent = config.title;

  const showBeat = type === 'prompt';
  const showVideoPrompt = type === 'video';
  const hasBeatRegen = type === 'prompt';
  els.entityModalBeatField.hidden = !showBeat;
  if (showBeat && document.activeElement !== els.entityModalBeat) els.entityModalBeat.value = scene.beat || '';
  els.entityModalBeat.disabled = busy;

  if (els.entityModalVideoPromptField) {
    els.entityModalVideoPromptField.hidden = !showVideoPrompt;
    if (showVideoPrompt && els.entityModalVideoPrompt && document.activeElement !== els.entityModalVideoPrompt) {
      els.entityModalVideoPrompt.value = scene.videoPrompt || '';
    }
    if (els.entityModalVideoPrompt) els.entityModalVideoPrompt.disabled = busy;
  }

  const isText = config.kind === 'text';
  els.entityModalTextField.hidden = !isText;
  els.entityModalTextFieldLabel.textContent = config.fieldLabel || '';
  if (isText && document.activeElement !== els.entityModalTextarea) els.entityModalTextarea.value = config.getValue(scene);
  els.entityModalTextarea.disabled = busy;
  els.entityModalTextHint.hidden = type !== 'dialogue';

  els.entityModalInstructionField.hidden = type !== 'dialogue';
  els.entityModalInstruction.disabled = busy;

  els.entityModalFallbackWarning.hidden = !(type === 'dialogue' && Boolean(scene.narrationIsFallback));

  // Scene expansion is an explicit storyboard-edit action the user opts into here, never an
  // incidental side effect of regenerating an image (see entityModalRegenBtn above).
  const expandSuggestion = type === 'dialogue' && !scene.narrationIsFallback ? suggestSceneCountFromNarration([scene]) : 0;
  els.entityModalExpandSection.hidden = !(expandSuggestion > 1);
  if (expandSuggestion > 1) {
    els.entityModalExpandText.textContent = `This scene's narration is long enough to comfortably fill ${expandSuggestion} images instead of 1.`;
    els.entityModalExpandBtn.textContent = `Expand into ${expandSuggestion} scenes`;
    els.entityModalExpandBtn.disabled = busy;
  }

  els.entityModalMedia.hidden = isText || recorderOpen;
  if (!isText) renderEntityModalMedia(scene, type, config);

  const beatLoading = isEntityLoading('action', scene, operation);
  const promptFieldLoading = type === 'prompt'
    ? (operation?.type === 'prompt' && operation.sceneId === scene.id)
    : isLoading;
  const hasExistingBeat = Boolean(String(scene.beat || '').trim());
  const hasExisting = hasExistingEntity(type, scene);
  els.entityModalRegenBeatBtn.hidden = !(showBeat && hasBeatRegen);
  els.entityModalRegenBeatBtn.disabled = busy;
  els.entityModalRegenBeatBtn.classList.toggle('is-loading', beatLoading);
  els.entityModalRegenBeatBtn.textContent = beatLoading ? (hasExistingBeat ? 'Regenerating…' : 'Generating…') : (hasExistingBeat ? 'Regenerate' : 'Generate');

  els.entityModalRegenTextBtn.hidden = !isText;
  els.entityModalRegenTextBtn.disabled = busy;
  els.entityModalRegenTextBtn.classList.toggle('is-loading', promptFieldLoading);
  els.entityModalRegenTextBtn.textContent = promptFieldLoading ? (hasExisting ? 'Regenerating…' : 'Generating…') : (hasExisting ? 'Regenerate' : 'Generate');

  const stale = (type === 'prompt' && computeStaleness(scene).promptStale)
    || (type === 'video' && (computeStaleness(scene).videoPromptStale || computeStaleness(scene).videoStale || !String(scene.videoPrompt || '').trim()));
  els.entityModalStaleWarning.hidden = !stale;
  if (stale && type === 'video' && !String(scene.videoPrompt || '').trim()) {
    els.entityModalStaleWarning.textContent = 'Video motion is missing or was cleared — replan visuals before generating video, or video will fall back to still action.';
  } else if (stale) {
    els.entityModalStaleWarning.textContent = 'This visual or motion plan may be stale — still action or narration changed after it was generated.';
  }

  els.entityModalRegenBtn.hidden = isText;
  els.entityModalRegenBtn.disabled = controlsBusy;
  els.entityModalRegenBtn.classList.toggle('is-loading', isLoading);
  els.entityModalRegenBtn.textContent = isLoading ? (hasExisting ? 'Regenerating' : 'Generating') : (hasExisting ? 'Regenerate' : 'Generate');

  els.entityModalRecordAudioBtn.hidden = type !== 'audio' || recorderOpen;
  els.entityModalRecordAudioBtn.disabled = controlsBusy;

  const modalLibraryBtn = document.getElementById('entityModalLibraryBtn');
  if (modalLibraryBtn) {
    const showLibrary = type === 'image';
    modalLibraryBtn.hidden = !showLibrary;
    // The button's own inline `style="display: flex"` (needed to lay out its icon + label) has
    // higher cascade priority than the `[hidden]{display:none}` UA rule, so `.hidden` alone doesn't
    // actually hide it — toggle the inline display directly instead.
    modalLibraryBtn.style.display = showLibrary ? 'flex' : 'none';
    modalLibraryBtn.disabled = busy;
  }

  const modalReferencesBtn = document.getElementById('entityModalReferencesBtn');
  if (modalReferencesBtn) {
    const showReferences = type === 'image';
    modalReferencesBtn.hidden = !showReferences;
    modalReferencesBtn.style.display = showReferences ? 'flex' : 'none';
    modalReferencesBtn.disabled = busy;
  }

  els.entityModalStatus.textContent = isLoading ? 'Regeneration in progress…' : (busy ? 'Another operation is running…' : '');

  renderEntityModalHistory(scene, type, config, controlsBusy);
}

function renderEntityModal() {
  if (!els.entityModal?.open) return;
  renderSceneController();
  els.entityModalDetail.hidden = !modalState.type;
  if (modalState.type) renderEntityDetail();
}

function generateControllerEntity(type) {
  const index = currentEntityModalSceneIndex();
  if (index === -1 || !ENTITY_CONFIG[type]) return;
  const scene = sceneStore.get().scenes[index];
  const config = ENTITY_CONFIG[type];
  const confirmationOptions = {
    entityType: type,
    ...(type === 'video' ? { videoScene: scene, sceneIndex: index } : {}),
  };
  confirmRegeneration(`Generate ${config.title.toLowerCase()} for scene ${index + 1}?`, 'Generate', confirmationOptions)
    .then((confirmed) => {
      if (!confirmed) return;
      runGenerationWorkflow(type, index, els, (message) => { els.statusText.textContent = message; })
        .then(refreshJobsAndRerenderScenes)
        .then(renderEntityModal);
    });
}

function setupEntityModal() {
  const modal = els.entityModal;
  if (!modal || modal.dataset.wired) return;
  modal.dataset.wired = 'true';

  const pauseOtherPlayers = () => {
    activeScenePlayback?.pause();
    [els.timelineVideo, els.timelineAudio].forEach((el) => { if (el && !el.paused) el.pause(); });
  };
  els.entityModalVideo.addEventListener('play', pauseOtherPlayers);
  els.entityModalAudio.addEventListener('play', pauseOtherPlayers);
  els.entityModalAudio.addEventListener('timeupdate', () => renderCaptionInto(modalState.captionTarget, modalState.alignmentWords, els.entityModalAudio.currentTime));

  // Capture play events on the history list for delegation
  els.entityModalHistoryList.addEventListener('play', (e) => {
    if (e.target.tagName === 'AUDIO') {
      activeScenePlayback?.pause();
    }
  }, true);

  els.closeEntityModalBtn.addEventListener('click', () => modal.close());
  els.entityModalDetailCloseBtn.addEventListener('click', () => {
    modalState.type = null;
    modalState.mediaPath = undefined;
    closeSceneAudioRecorder(els);
    renderEntityModal();
  });
  const moveScene = (offset) => {
    const index = currentEntityModalSceneIndex();
    const scene = sceneStore.get().scenes[index + offset];
    if (!scene) return;
    modalState.sceneId = scene.id;
    modalState.type = null;
    modalState.configType = null;
    modalState.mediaPath = undefined;
    closeSceneAudioRecorder(els);
    renderEntityModal();
  };
  els.entityModalPreviousBtn.addEventListener('click', () => moveScene(-1));
  els.entityModalNextBtn.addEventListener('click', () => moveScene(1));
  els.entityModalDeleteBtn.addEventListener('click', () => {
    if (uiStore.get().operation) return;
    const sceneId = modalState.sceneId;
    modal.close();
    window.dispatchEvent(new CustomEvent('storyboard:delete-scene', { detail: { sceneId } }));
  });
  els.entityControllerRows.addEventListener('click', (event) => {
    const generate = event.target.closest('[data-entity-generate]');
    if (generate && !generate.disabled) {
      generateControllerEntity(generate.dataset.entityGenerate);
      return;
    }
    const change = event.target.closest('[data-entity-config]');
    if (change) {
      modalState.configType = modalState.configType === change.dataset.entityConfig ? null : change.dataset.entityConfig;
      renderEntityModal();
      return;
    }
    const cancel = event.target.closest('[data-entity-config-cancel]');
    if (cancel) {
      modalState.configType = null;
      renderEntityModal();
      return;
    }
    const useDefault = event.target.closest('[data-entity-use-default]');
    if (useDefault) {
      const index = currentEntityModalSceneIndex();
      clearSceneConfigOverride(index, useDefault.dataset.entityUseDefault);
      modalState.configType = null;
      return;
    }
    const editDefaults = event.target.closest('[data-entity-edit-defaults]');
    if (editDefaults) {
      modal.close();
      els.settingsBtn?.click();
      return;
    }
    const apply = event.target.closest('[data-entity-config-apply]');
    if (apply) {
      const type = apply.dataset.entityConfigApply;
      const editor = els.entityControllerRows.querySelector(`[data-config-editor="${type}"]`);
      const override = {};
      for (const control of editor?.querySelectorAll('[name]') || []) {
        override[control.name] = control.type === 'number'
          ? (control.value === '' ? null : Number(control.value))
          : control.value;
      }
      applySceneConfigOverride(currentEntityModalSceneIndex(), type, override);
      modalState.configType = null;
    }
  });
  els.entityControllerRows.addEventListener('change', (event) => {
    const textarea = event.target.closest('[data-entity-text]');
    if (!textarea) return;
    const type = textarea.dataset.entityText;
    replaceScene(currentEntityModalSceneIndex(), (scene) => ENTITY_CONFIG[type].setValue(scene, textarea.value));
  });
  modal.addEventListener('click', (event) => { if (event.target === modal) modal.close(); });
  modal.addEventListener('close', () => {
    closeSceneAudioRecorder(els);
    modalState.historyAbortController?.abort();
    modalState.mediaAbortController?.abort();
    modalState.sceneId = null;
    modalState.type = null;
    modalState.configType = null;
    modalState.mediaPath = undefined;
    els.entityModalVideo.pause();
    els.entityModalVideo.removeAttribute('src');
    els.entityModalVideo.load();
    els.entityModalAudio.pause();
    els.entityModalAudio.removeAttribute('src');
    els.entityModalAudio.load();
    els.entityModalImage.removeAttribute('src');
  });

  els.entityModalRecordAudioBtn.addEventListener('click', async () => {
    const index = currentEntityModalSceneIndex();
    if (index === -1) return;
    const scene = sceneStore.get().scenes[index];
    const opening = openSceneAudioRecorder(scene, els);
    renderEntityModal();
    await opening;
  });
  els.sceneAudioMicSelect.addEventListener('change', () => switchSceneAudioMicrophone(els.sceneAudioMicSelect.value, els));
  els.sceneAudioMonitorMic.addEventListener('change', () => setSceneAudioMonitoring(els.sceneAudioMonitorMic.checked));
  els.sceneAudioReduceNoise.addEventListener('change', () => setSceneAudioNoiseSuppression(els.sceneAudioReduceNoise.checked, els));
  els.sceneAudioRecordToggle.addEventListener('click', () => toggleSceneAudioRecording(els).catch((error) => { els.sceneAudioRecordStatus.textContent = `Recording could not start: ${error.message}`; }));
  els.sceneAudioPreviewBtn.addEventListener('click', () => previewSceneAudioRecording(els).catch((error) => { els.sceneAudioRecordStatus.textContent = `Preview failed: ${error.message}`; }));
  els.sceneAudioRetakeBtn.addEventListener('click', () => retakeSceneAudioRecording(els));
  els.sceneAudioCancelBtn.addEventListener('click', () => { closeSceneAudioRecorder(els); renderEntityModal(); });
  els.sceneAudioSubmitBtn.addEventListener('click', async () => {
    const index = currentEntityModalSceneIndex();
    if (index === -1) return;
    const scene = sceneStore.get().scenes[index];
    try {
      await submitSceneAudioRecording(scene, index, els, (message) => { els.statusText.textContent = message; });
      await refreshJobsAndRerenderScenes();
      renderEntityModal();
    } catch (_) { /* recorder displays the actionable upload error */ }
  });

  const libraryBtn = document.getElementById('entityModalLibraryBtn');
  libraryBtn?.addEventListener('click', () => {
    const index = currentEntityModalSceneIndex();
    if (index === -1) return;
    const scene = sceneStore.get().scenes[index];
    els.entityModal.close();
    import('./image-library-controller.js').then(({ openImageLibrary }) => {
      openImageLibrary({
        mode: 'scene-image',
        sceneId: scene.id,
        sceneNumber: index + 1,
        sceneTitle: scene.title,
        domEls: els,
        setStatus: (msg) => {
          const statusText = document.getElementById('statusText');
          if (statusText) statusText.textContent = msg;
        }
      });
    });
  });

  const referencesBtn = document.getElementById('entityModalReferencesBtn');
  referencesBtn?.addEventListener('click', () => {
    const index = currentEntityModalSceneIndex();
    if (index === -1) return;
    els.entityModal.close();
    openSceneReferencesModal(index);
  });

  els.entityModalRegenBtn.addEventListener('click', () => {
    const index = currentEntityModalSceneIndex();
    if (index === -1) return;
    const config = ENTITY_CONFIG[modalState.type];
    const scene = sceneStore.get().scenes[index];
    const verb = hasExistingEntity(modalState.type, scene) ? 'Regenerate' : 'Generate';
    const confirmationOptions = {
      entityType: modalState.type,
      ...(modalState.type === 'video' ? { videoScene: scene, sceneIndex: index } : {}),
    };
    confirmRegeneration(`${verb} the ${config.title.toLowerCase()} for scene ${index + 1}?and make it active`, verb, confirmationOptions).then((confirmed) => {
      if (!confirmed) return;
      // Close immediately so the scene card's own spinner (driven by uiStore.operation, set
      // synchronously inside regenerate* before its first await) is visible right away, instead of
      // running invisibly behind a modal that never closes itself.
      els.entityModal.close();
      runGenerationWorkflow(modalState.type, index, els, (t) => els.statusText.textContent = t).then(refreshJobsAndRerenderScenes);
    });
  });

  els.entityModalExpandBtn.addEventListener('click', () => {
    const index = currentEntityModalSceneIndex();
    if (index === -1) return;
    const scene = sceneStore.get().scenes[index];
    const suggested = suggestSceneCountFromNarration([scene]);
    if (suggested <= 1) return;
    confirmRegeneration(`Split scene ${index + 1} into ${suggested} scenes based on its narration? This changes the storyboard structure — existing image/audio/video for this scene apply only to the first of the new scenes.`, 'Split', { entityType: 'dialogue' }).then((confirmed) => {
      if (confirmed) {
        splitSceneInPlace(index, suggested, els, (t) => els.statusText.textContent = t)
          .then((didSplit) => { if (didSplit) els.entityModal.close(); })
          .catch((error) => { els.statusText.textContent = `Scene split failed: ${error.message}`; });
      }
    });
  });

  els.entityModalRegenBeatBtn.addEventListener('click', () => {
    const index = currentEntityModalSceneIndex();
    if (index === -1) return;
    if (modalState.type !== 'prompt') return;
    const scene = sceneStore.get().scenes[index];
    const verb = Boolean(String(scene.beat || '').trim()) ? 'Regenerate' : 'Generate';
    confirmRegeneration(`${verb} the still action for scene ${index + 1}? This marks the visual prompt and video motion as needing update.`, verb, { entityType: 'action' }).then((confirmed) => {
      if (confirmed) runGenerationWorkflow('action', index, els, (t) => els.statusText.textContent = t).then(refreshJobsAndRerenderScenes);
    });
  });

  els.entityModalRegenTextBtn.addEventListener('click', () => {
    const index = currentEntityModalSceneIndex();
    if (index === -1) return;
    const config = ENTITY_CONFIG[modalState.type];
    const scene = sceneStore.get().scenes[index];
    const verb = hasExistingEntity(modalState.type, scene) ? 'Regenerate' : 'Generate';
    confirmRegeneration(`${verb} the ${(config.fieldLabel || config.title).toLowerCase()} for scene ${index + 1}? This replaces the current version.`, verb, { entityType: modalState.type }).then((confirmed) => {
      if (confirmed) runGenerationWorkflow(modalState.type, index, els, (t) => els.statusText.textContent = t).then(refreshJobsAndRerenderScenes);
    });
  });

  els.entityModalBeat.addEventListener('input', () => {
    const index = currentEntityModalSceneIndex();
    if (index === -1) return;
    const value = els.entityModalBeat.value;
    updateScene(index, (scene) => {
      scene.beat = value;
      invalidateVideoMotion(scene);
    }, { sync: 'debounced', statusCallback: (msg) => { els.statusText.textContent = msg; } });
  });

  if (els.entityModalVideoPrompt) {
    els.entityModalVideoPrompt.addEventListener('input', () => {
      const index = currentEntityModalSceneIndex();
      if (index === -1) return;
      const value = els.entityModalVideoPrompt.value;
      updateScene(index, (scene) => {
        scene.videoPrompt = value;
        scene.videoPromptGeneratedFromBeat = scene.beat || '';
        scene.videoPromptGeneratedFromNarration = scene.narrationText || null;
      }, { sync: 'debounced', statusCallback: (msg) => { els.statusText.textContent = msg; } });
    });
  }

  els.entityModalTextarea.addEventListener('input', () => {
    const index = currentEntityModalSceneIndex();
    if (index === -1) return;
    const value = els.entityModalTextarea.value;
    updateScene(index, (scene) => {
      ENTITY_CONFIG[modalState.type].setValue(scene, value);
      if (modalState.type === 'dialogue' || modalState.type === 'action') invalidateVideoMotion(scene);
    }, { sync: 'debounced', statusCallback: (msg) => { els.statusText.textContent = msg; } });
  });

  els.entityModalHistoryList.addEventListener('click', (event) => {
    const index = currentEntityModalSceneIndex();
    if (index === -1) return;
    const target = event.target.closest('.audio-version-select') || event.target.closest('.version-thumb');
    if (!target || target.disabled) return;
    const vIndex = parseInt(target.dataset.vindex, 10);
    selectSceneEntityVersion(index, modalState.type, vIndex);
  });
}

export function initRendering(domEls) {
  els = domEls;
  setupConfirmModal();
  setupEntityModal();
  setupSceneReferencesModal();

  const handleSceneCardClick = (e) => {
    const card = e.target.closest('.scene-card');
    if (!card) return;
    const sceneId = card.dataset.sceneId;
    const index = sceneStore.get().scenes.findIndex(s => s.id === sceneId);
    const scene = sceneStore.get().scenes[index];
    if (!scene) return;

    // Any interaction with a card — the card itself or its scene controller —
    // selects it as the Start run's anchor, on top of whatever else the click does below. Locked
    // while a run is active (uiStore.operation set) so a stray click mid-run can't be mistaken for
    // changing the run's target — the run's range was already frozen at confirm time regardless, but
    // letting the visible "selected" card drift during a run reads as if the target changed. Once the
    // run stops, buildBatchFns's own progress tracking (stages.js) lands selection on wherever it
    // actually stopped, and manual selection is free again from there.
    if (uiStore.get().operation == null && uiStore.get().selectedSceneId !== scene.id) uiStore.set({ selectedSceneId: scene.id });

    const manageBtn = e.target.closest('.scene-manage-btn');
    if (manageBtn && !manageBtn.disabled) {
      openEntityModal(index);
    }
  };
  els.storyboardGrid.addEventListener('click', handleSceneCardClick);
  els.storyboardSlider.addEventListener('click', handleSceneCardClick);

  sceneStore.subscribe(() => { renderScenes(); renderEntityModal(); renderSceneReferencesModal(); });
  generationStore.subscribe(() => renderSceneReferencesModal());
  uiStore.subscribe(() => { renderScenes(); renderEntityModal(); });
}



export function renderScenes() {
  const scenes = sceneStore.get().scenes;
  const operation = uiStore.get().operation;
  const selectedIndex = resolveSelectedSceneIndex(scenes, uiStore.get().selectedSceneId);

  els.storyboardSection.hidden = scenes.length === 0;


  const existingCards = Array.from(els.storyboardSection.querySelectorAll('.scene-card'));
  const existingNodesMap = new Map(existingCards.map(node => [node.dataset.sceneId, node]));

  const nextScenePlaybackCleanups = new Map();
  const nextNodes = [];

  // Per-scene "did the last attempt for this entity fail" — otherwise a failed generation (LLM rate
  // limit, provider outage, missing voice config, whatever) leaves zero trace on the card itself:
  // the icon just reverts to the same dim "never attempted" look, indistinguishable from a scene
  // that was simply never touched. Computed once per render pass, not per scene, since it's the same
  // lookup for every scene of a given type.
  const recentJobs = getCachedJobs();
  const latestJobsByStatus = {
    action: buildLatestJobsByScene(recentJobs, 'action'),
    prompt: buildLatestJobsByScene(recentJobs, 'prompt'),
    image: buildLatestJobsByScene(recentJobs, 'image'),
    dialogue: buildLatestJobsByScene(recentJobs, 'dialogue'),
    audio: buildLatestJobsByScene(recentJobs, 'audio'),
    video: buildLatestJobsByScene(recentJobs, 'video'),
    subtitle: buildLatestJobsByScene(recentJobs, 'subtitle'),
  };

  scenes.forEach((scene, index) => {
    let node = existingNodesMap.get(scene.id);
    if (!node) {
      node = els.sceneCardTemplate.content.firstElementChild.cloneNode(true);
      node.dataset.sceneId = scene.id;
    }

    const sceneIndexEl = node.querySelector('.scene-index');
    const titleEl = node.querySelector('.scene-title');
    const imageEl = node.querySelector('.scene-image');
    const videoEl = node.querySelector('.scene-video');
    const placeholderEl = node.querySelector('.scene-placeholder');
    const playbackToggleEl = node.querySelector('.scene-media-toggle');
    const playbackAudioEl = node.querySelector('.scene-audio');
    const manageBtn = node.querySelector('.scene-manage-btn');
    const manageSummary = node.querySelector('.scene-manage-summary');

    sceneIndexEl.dataset.index = String(index + 1);
    titleEl.textContent = scene.title || `Scene ${index + 1}`;

    const busy = operation != null;
    const loadingByType = Object.fromEntries(Object.keys(ENTITY_CONFIG).map((type) => [type, isEntityLoading(type, scene, operation)]));
    const statuses = entityStatuses(scene, operation, recentJobs, latestJobsByStatus);
    const summary = sceneStatusSummary(statuses);
    manageSummary.textContent = summary;
    manageBtn.disabled = busy;
    manageBtn.classList.toggle('has-unrun', Object.values(statuses).some((status) => status.key === 'missing'));
    manageBtn.classList.toggle('needs-update', Object.values(statuses).some((status) => status.key === 'stale'));
    manageBtn.classList.toggle('has-failure', Object.values(statuses).some((status) => status.key === 'failed'));
    manageBtn.classList.toggle('is-loading', Object.values(statuses).some((status) => status.key === 'generating'));
    manageBtn.setAttribute('aria-label', `Scene controls: ${summary}`);
    manageBtn.title = summary;

    const shot = imageShot(scene);


    const activeVersion = shot.versions?.[shot.activeVersionIndex];
    const activeVideoVersion = shot.videoVersions?.[shot.activeVideoVersionIndex];
    const currentVideoPath = activeVideoVersion?.path || '';
    const currentPosterPath = activeVersion?.path || '';

    if (scene.activeVisualType === 'video' && currentVideoPath) {
      setElementProtectedAsset(videoEl, 'src', currentVideoPath, 'asset');
      setElementProtectedAsset(videoEl, 'poster', currentPosterPath, 'poster');
      videoEl.style.display = 'block';
      
      setElementProtectedAsset(imageEl, 'src', '', 'asset');
      imageEl.style.display = 'none';
      placeholderEl.style.display = 'none';
    } else if (currentPosterPath) {
      setElementProtectedAsset(imageEl, 'src', currentPosterPath, 'asset');
      imageEl.style.display = 'block';
      
      const hadVideoAsset = videoEl.dataset.assetPath;
      const hadVideoPoster = videoEl.dataset.posterPath;
      setElementProtectedAsset(videoEl, 'src', '', 'asset');
      setElementProtectedAsset(videoEl, 'poster', '', 'poster');
      if (hadVideoAsset || hadVideoPoster) {
        videoEl.load();
      }
      videoEl.style.display = 'none';
      placeholderEl.style.display = 'none';
    } else {
      setElementProtectedAsset(imageEl, 'src', '', 'asset');
      imageEl.style.display = 'none';
      
      const hadVideoAsset = videoEl.dataset.assetPath;
      const hadVideoPoster = videoEl.dataset.posterPath;
      setElementProtectedAsset(videoEl, 'src', '', 'asset');
      setElementProtectedAsset(videoEl, 'poster', '', 'poster');
      if (hadVideoAsset || hadVideoPoster) {
        videoEl.load();
      }
      videoEl.style.display = 'none';
      placeholderEl.style.display = 'flex';
    }

    const activeAudioVersion = scene.audioVersions?.[scene.activeAudioVersionIndex];
    const currentAudioPath = activeAudioVersion?.path || '';
    const prevAudioPath = playbackAudioEl.dataset.assetPath;
    setElementProtectedAsset(playbackAudioEl, 'src', currentAudioPath, 'asset');
    if (!currentAudioPath && prevAudioPath) {
      playbackAudioEl.load();
    }

    const activeSubtitleVersion = scene.subtitleVersions?.[scene.activeSubtitleVersionIndex];
    const currentSubtitlePath = activeSubtitleVersion?.path || '';
    // Only trust this version's word timing while it's still paired with the audio actually
    // playing here -- once audio is regenerated the subtitle goes stale and its timestamps no
    // longer line up with what's coming out of the speakers, which would look like broken
    // alignment rather than what it actually is (a subtitle that needs regenerating).
    const subtitleWords = activeSubtitleVersion?.sourceAudioPath === currentAudioPath ? (activeSubtitleVersion?.words || []) : [];
    const captionEl = node.querySelector('.scene-caption');
    if (captionEl) captionEl.dataset.captionStyle = activeSubtitleVersion?.style || 'classic';

    const hasVideo = scene.activeVisualType === 'video' && Boolean(currentVideoPath);
    const hasAudio = Boolean(currentAudioPath);
    const playbackKey = `${hasVideo}-${currentVideoPath}-${hasAudio}-${currentAudioPath}-${currentSubtitlePath}`;

    if (node.dataset.playbackKey !== playbackKey) {
      if (scenePlaybackCleanups.has(scene.id)) {
        scenePlaybackCleanups.get(scene.id)();
      }
      nextScenePlaybackCleanups.set(scene.id, setupScenePlayback({
        toggle: playbackToggleEl,
        video: videoEl,
        audio: playbackAudioEl,
        hasVideo,
        hasAudio,
        words: subtitleWords,
        captionEl,
        onPlayStart: () => {
          document.querySelectorAll('.audio-version-thumb audio').forEach((element) => element.pause());
          [els.timelineVideo, els.timelineAudio].forEach((element) => { if (element && !element.paused) element.pause(); });
        }
      }));
      node.dataset.playbackKey = playbackKey;
    } else {
      if (scenePlaybackCleanups.has(scene.id)) {
        nextScenePlaybackCleanups.set(scene.id, scenePlaybackCleanups.get(scene.id));
      }
    }

    node.classList.toggle('is-busy', Object.values(loadingByType).some(Boolean));
    node.classList.toggle('is-selected', index === selectedIndex);
    node.querySelector('.image-loading').classList.toggle('visible', loadingByType.image);
    node.querySelector('.video-loading').classList.toggle('visible', loadingByType.video);
    node.querySelector('.audio-loading').classList.toggle('visible', loadingByType.audio);

    nextNodes.push(node);
    existingNodesMap.delete(scene.id);
  });
  
  existingNodesMap.forEach((node, sceneId) => {
    if (scenePlaybackCleanups.has(sceneId)) {
      scenePlaybackCleanups.get(sceneId)();
    }
    node.remove();
  });
  scenePlaybackCleanups = nextScenePlaybackCleanups;
  
  els.storyboardGrid.replaceChildren(...nextNodes);
  renderStoryboardSlider(scenes, selectedIndex);
}

function renderStoryboardSlider(scenes, selectedIndex) {
  const slider = els.storyboardSlider;
  if (!slider || slider.hidden) return;

  const safeIndex = Math.min(Math.max(selectedIndex, 0), Math.max(scenes.length - 1, 0));
  const activeScene = scenes[safeIndex];
  const stage = slider.querySelector('.storyboard-slider-stage');
  const previous = slider.querySelector('.storyboard-slider-prev');
  const next = slider.querySelector('.storyboard-slider-next');
  const filmstrip = slider.querySelector('.storyboard-filmstrip');

  previous.disabled = safeIndex <= 0;
  next.disabled = safeIndex >= scenes.length - 1;

  const activeCard = activeScene
    ? Array.from(els.storyboardGrid.children).find((card) => card.dataset.sceneId === activeScene.id)
    : null;
  stage.replaceChildren(...(activeCard ? [activeCard] : []));

  const previousSelection = slider.dataset.sceneId || '';
  const existingThumbnails = new Map(
    Array.from(filmstrip.querySelectorAll('.storyboard-filmstrip-item'))
      .map((button) => [button.dataset.sceneId, button]),
  );
  const thumbnails = scenes.map((scene, index) => {
    const button = existingThumbnails.get(scene.id) || document.createElement('button');
    if (!button.classList.contains('storyboard-filmstrip-item')) {
      button.type = 'button';
      button.className = 'storyboard-filmstrip-item';
      button.append(document.createElement('span'), document.createElement('span'));
    }
    button.dataset.sceneId = scene.id;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(index === safeIndex));
    button.setAttribute('aria-label', `Open scene ${index + 1}: ${scene.title || `Scene ${index + 1}`}`);

    const visual = button.firstElementChild;
    visual.className = 'storyboard-filmstrip-visual';
    const shot = imageShot(scene);
    const imagePath = shot.versions?.[shot.activeVersionIndex]?.path || '';
    if (imagePath) {
      const image = visual.querySelector('img') || document.createElement('img');
      image.alt = '';
      image.draggable = false;
      if (!image.isConnected) visual.replaceChildren(image);
      setElementProtectedAsset(image, 'src', imagePath, 'asset');
    } else {
      visual.textContent = String(index + 1).padStart(2, '0');
    }

    const label = button.lastElementChild;
    label.className = 'storyboard-filmstrip-label';
    label.textContent = `${String(index + 1).padStart(2, '0')} · ${scene.title || `Scene ${index + 1}`}`;
    return button;
  });
  filmstrip.replaceChildren(...thumbnails);
  slider.dataset.sceneId = activeScene?.id || '';
  if (previousSelection !== slider.dataset.sceneId) {
    filmstrip.querySelector('[aria-selected="true"]')?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }
}
