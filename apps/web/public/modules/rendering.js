import { sceneStore, generationStore, uiStore, projectStore, debounce } from './store.js';
import { regeneratePrompt, regenerateAction, regenerateDialogue, regenerateImage, regenerateAudio, regenerateVideo, regenerateSubtitles, splitSceneInPlace } from './workflows.js';
import { renderCaptionInto } from './subtitle-overlay.js';
import { ensureProjectSynced, getCurrentStoryboardRecord, persistStoryboardLibrary, queueSync } from './persistence.js';
import { loadProtectedAsset } from './assets.js';
import { api } from './api.js';
import { suggestSceneCountFromNarration } from './scene-count.js';
import { computeStaleness, resolveSelectedSceneIndex, getCachedJobs, refreshRecentJobs, refreshSpend, buildLatestJobsByScene } from './stages.js';
import { adaptSceneImageShot, imageShot, setActiveImageVersion, setActiveVideoVersion, setImagePrompt, setVideoKeyframes } from './scene-shots.js';
import { REFERENCE_ROLES, REFERENCE_ROLE_LABELS, normalizeReferenceRole } from './reference-roles.js';
import { textValue } from './text-values.js';
import {
  closeSceneAudioRecorder, openSceneAudioRecorder, previewSceneAudioRecording,
  retakeSceneAudioRecording, setSceneAudioMonitoring, setSceneAudioNoiseSuppression,
  submitSceneAudioRecording, switchSceneAudioMicrophone,
  toggleSceneAudioRecording,
} from './scene-audio-recorder.js';

let els = {};
let activeScenePlayback = null;
let scenePlaybackCleanups = new Map();

const debouncedQueueSync = debounce(() => {
  const record = getCurrentStoryboardRecord();
  if (record) { queueSync(record, (t) => els.statusText.textContent = t); }
}, 500);

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
};

const referenceModalState = { sceneId: null };

const STATUS_LABELS = { dialogue: 'Narration' };

const handleAssetError = (err) => {
  if (err.name !== 'AbortError') console.error('Asset load error:', err);
};

function setElementProtectedAsset(element, propertyName, path, cacheKeyName = propertyName) {
  const datasetKey = cacheKeyName + 'Path';
  const abortKey = '_' + cacheKeyName + 'Abort';
  
  if (element.dataset[datasetKey] !== path) {
    element.dataset[datasetKey] = path;
    if (element[abortKey]) {
      element[abortKey].abort();
      element[abortKey] = null;
    }
    if (path) {
      const controller = new AbortController();
      element[abortKey] = controller;
      loadProtectedAsset(path, { signal: controller.signal })
        .then(url => {
          if (url && element.dataset[datasetKey] === path) {
            element[propertyName] = url;
          }
        })
        .catch(handleAssetError);
    } else {
      element.removeAttribute(propertyName);
    }
  }
}

const ENTITY_CONFIG = {
  prompt: {
    title: 'Image Prompt',
    kind: 'text',
    fieldLabel: 'Visual prompt',
    getValue: (scene) => textValue(scene.prompt, ['prompt']),
    setValue: (scene, value) => { setImagePrompt(scene, value); },
    regen: (index, els, cb) => regeneratePrompt(index, els, cb),
    regenBeat: (index, els, cb) => regenerateAction(index, els, cb),
  },
  dialogue: {
    title: 'Spoken Narration',
    kind: 'text',
    fieldLabel: 'Spoken Narration',
    getValue: (scene) => textValue(scene.narrationText, ['narrationText']),
    setValue: (scene, value) => { scene.narrationText = value; scene.narrationIsFallback = false; },
    regen: (index, els, cb) => regenerateDialogue(index, els, cb, els.entityModalInstruction?.value.trim() || ''),
  },
  image: {
    title: 'Image',
    kind: 'image',
    versions: (scene) => scene.versions || [],
    activeIndex: (scene) => scene.activeVersionIndex,
    selectVersion: (scene, vIndex) => { setActiveImageVersion(scene, vIndex); scene.activeVisualType = 'image'; },
    // regenerate* throws deliberately on unmet prerequisites so the caller "has to consciously deal
    // with it" rather than silently no-op-ing — surface that via the same setStatus callback used
    // for progress messages, instead of discarding it.
    regen: (index, els, cb) => regenerateImage(index, null, els, cb).catch((error) => cb(error.message)),
  },
  audio: {
    title: 'Audio',
    kind: 'audio',
    versions: (scene) => scene.audioVersions || [],
    activeIndex: (scene) => scene.activeAudioVersionIndex,
    selectVersion: (scene, vIndex) => { scene.activeAudioVersionIndex = vIndex; },
    regen: (index, els, cb) => regenerateAudio(index, null, els, cb).catch((error) => cb(error.message)),
  },
  video: {
    title: 'Video',
    kind: 'video',
    versions: (scene) => imageShot(scene).videoVersions || [],
    activeIndex: (scene) => imageShot(scene).activeVideoVersionIndex,
    selectVersion: (scene, vIndex) => { setActiveVideoVersion(scene, vIndex); scene.activeVisualType = 'video'; },
    regen: (index, els, cb) => regenerateVideo(index, null, els, cb).catch((error) => cb(error.message)),
  },
  subtitle: {
    title: 'Subtitles',
    kind: 'subtitle',
    versions: (scene) => scene.subtitleVersions || [],
    activeIndex: (scene) => scene.activeSubtitleVersionIndex,
    selectVersion: (scene, vIndex) => { scene.activeSubtitleVersionIndex = vIndex; },
    regen: (index, els, cb) => regenerateSubtitles(index, null, els, cb).catch((error) => cb(error.message)),
  },
};

function isEntityLoading(type, scene, operation) {
  if (!operation) return false;
  switch (type) {
    case 'prompt': return operation.type === 'prompts' || ((operation.type === 'prompt' || operation.type === 'action') && operation.sceneId === scene.id);
    case 'action': return operation.type === 'action' && operation.sceneId === scene.id;
    case 'image': return ['image', 'imagesSerial'].includes(operation.type) && operation.sceneId === scene.id;
    case 'dialogue': return operation.type === 'dialogueAll' || (operation.type === 'dialogue' && operation.sceneId === scene.id);
    case 'audio': return ['audio', 'audioSerial'].includes(operation.type) && operation.sceneId === scene.id;
    case 'video': return ['video', 'videosSerial'].includes(operation.type) && operation.sceneId === scene.id;
    case 'subtitle': return ['subtitle', 'subtitlesSerial'].includes(operation.type) && operation.sceneId === scene.id;
    default: return false;
  }
}

// Distinguishes "nothing here yet" from "there's already a version" so entity-modal buttons/confirm
// copy can say Generate vs. Regenerate accurately instead of always claiming a version exists.
function hasExistingEntity(type, scene) {
  const config = ENTITY_CONFIG[type];
  if (config.kind === 'text') return Boolean(String(config.getValue(scene) || '').trim());
  return (config.versions(scene) || []).some((version) => Boolean(version?.path));
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
    els.confirmVideoProviderLabel.textContent = providerName ? (VIDEO_PROVIDER_LABELS[providerName] || providerName) : 'Platform default';
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
    element.removeAttribute('src');
    element.dataset.assetPath = assetPath || '';
    element.hidden = !assetPath;
    if (assetPath) loadProtectedAsset(assetPath).then((url) => {
      if (url && element.dataset.assetPath === assetPath) element.src = url;
    }).catch(handleAssetError);
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
    const scenes = sceneStore.get().scenes.map((current, index) => {
      if (index !== sceneIndex) return current;
      const next = { ...current };
      setVideoKeyframes(next, els.confirmVideoStartFrame.value, els.confirmVideoEndFrame.value || null);
      return next;
    });
    sceneStore.set({ scenes });
    const currentRecord = getCurrentStoryboardRecord();
    if (currentRecord) { currentRecord.scenes = scenes; queueSync(currentRecord); }
  };
}

function confirmRegeneration(message, confirmLabel = 'Regenerate', options = {}) {
  return new Promise((resolve) => {
    modalState.confirmResolve = resolve;
    modalState.confirmApply = null;
    if (els.confirmVideoKeyframes) els.confirmVideoKeyframes.hidden = true;
    if (els.confirmVideoSummary) els.confirmVideoSummary.hidden = true;
    if (els.confirmVideoNeedsImageNote) els.confirmVideoNeedsImageNote.hidden = true;
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

function openEntityModal(index, type) {
  const scene = sceneStore.get().scenes[index];
  if (!scene || !ENTITY_CONFIG[type]) return;
  modalState.sceneId = scene.id;
  modalState.type = type;
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
  els.sceneReferencesModalSceneLabel.textContent = `Scene ${index + 1} · ${scene.title || 'Untitled'}`;
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
}

function replaceSceneFromReferenceResponse(data) {
  const updated = adaptSceneImageShot(data.scene);
  const scenes = sceneStore.get().scenes.map((scene) => scene.id === updated.id ? updated : scene);
  sceneStore.set({ scenes });
  const record = getCurrentStoryboardRecord();
  if (record) {
    record.scenes = scenes;
    record.revision = data.revision;
    persistStoryboardLibrary();
  }
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
    const scenes = sceneStore.get().scenes.map((scene, sceneIndex) => {
      if (sceneIndex !== index) return scene;
      const next = adaptSceneImageShot({ ...scene, shots: (scene.shots || []).map((shot) => ({ ...shot })) });
      const shot = imageShot(next);
      const disabled = new Set(shot.disabledStyleReferencePaths || []);
      if (checkbox.checked) disabled.delete(url); else disabled.add(url);
      shot.disabledStyleReferencePaths = [...disabled];
      return next;
    });
    sceneStore.set({ scenes });
    const record = getCurrentStoryboardRecord();
    if (record) { record.scenes = scenes; queueSync(record, (text) => { els.sceneReferencesSaveNote.textContent = text; }); }
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
      replaceSceneFromReferenceResponse(data); els.sceneReferencesSaveNote.textContent = 'Uploaded';
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
      replaceSceneFromReferenceResponse(data); els.sceneReferencesSaveNote.textContent = 'Deleted';
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
      replaceSceneFromReferenceResponse(data); els.sceneReferencesSaveNote.textContent = 'Role saved';
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

  if (type === 'image') {
    els.entityModalImage.dataset.assetPath = path;
    loadProtectedAsset(path, { signal }).then((url) => { if (url && els.entityModalImage.dataset.assetPath === path && modalState.mediaPath === path) els.entityModalImage.src = url; }).catch(handleAssetError);
    els.entityModalImage.hidden = false;
  } else if (type === 'video') {
    els.entityModalVideo.dataset.assetPath = path;
    loadProtectedAsset(path, { signal }).then((url) => { if (url && els.entityModalVideo.dataset.assetPath === path && modalState.mediaPath === path) els.entityModalVideo.src = url; }).catch(handleAssetError);
    els.entityModalVideo.hidden = false;
  } else if (type === 'audio') {
    els.entityModalAudio.dataset.assetPath = path;
    loadProtectedAsset(path, { signal }).then((url) => { if (url && els.entityModalAudio.dataset.assetPath === path && modalState.mediaPath === path) els.entityModalAudio.src = url; }).catch(handleAssetError);
    els.entityModalAudio.hidden = false;
    const words = active?.alignment?.words || [];
    modalState.alignmentWords = words;
    modalState.captionTarget = els.entityModalAudioCaption;
    renderCaptionInto(els.entityModalAudioCaption, words, 0);
  } else if (type === 'subtitle') {
    // A subtitle version has no visual asset of its own, so preview it against the scene's current
    // image/video. Audio is different: play `sourceAudioPath` (the exact clip this version's word
    // timing was computed against), not necessarily the scene's current active audio -- if audio has
    // since been regenerated, the two would drift apart and the karaoke preview would look broken
    // (captions no longer matching the words actually being spoken) instead of just being stale.
    const shot = imageShot(scene);
    const visualVersions = scene.activeVisualType === 'video' ? shot.videoVersions : shot.versions;
    const visualIndex = scene.activeVisualType === 'video' ? shot.activeVideoVersionIndex : shot.activeVersionIndex;
    const visualPath = visualVersions?.[visualIndex]?.path || null;
    const visualEl = scene.activeVisualType === 'video' ? els.entityModalVideo : els.entityModalImage;
    if (visualPath) {
      visualEl.dataset.assetPath = visualPath;
      loadProtectedAsset(visualPath, { signal }).then((url) => { if (url && visualEl.dataset.assetPath === visualPath && modalState.mediaPath === path) visualEl.src = url; }).catch(handleAssetError);
      visualEl.hidden = false;
    }
    const audioPath = active?.sourceAudioPath || null;
    if (audioPath) {
      els.entityModalAudio.dataset.assetPath = audioPath;
      loadProtectedAsset(audioPath, { signal }).then((url) => { if (url && els.entityModalAudio.dataset.assetPath === audioPath && modalState.mediaPath === path) els.entityModalAudio.src = url; }).catch(handleAssetError);
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
      audio.dataset.assetPath = version.path;
      loadProtectedAsset(version.path, { signal }).then((url) => { if (url && audio.dataset.assetPath === version.path) audio.src = url; }).catch(handleAssetError);
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
    mediaEl.dataset.assetPath = version.path;
    loadProtectedAsset(version.path, { signal }).then((url) => { if (url && mediaEl.dataset.assetPath === version.path) mediaEl.src = url; }).catch(handleAssetError);
    const meta = document.createElement('div');
    meta.className = 'version-meta';
    const providerName = version.provider ? String(version.provider).replace(/^./, (letter) => letter.toUpperCase()) : '';
    meta.textContent = `v${vIndex + 1}${providerName ? ` · ${providerName}` : ''}`;
    btn.append(mediaEl, meta);

    els.entityModalHistoryList.appendChild(btn);
  });
}

function renderEntityModal() {
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

  els.entityModalSceneLabel.textContent = `Scene ${index + 1}`;
  els.entityModalTitle.textContent = config.title;

  const showBeat = type === 'prompt';
  const hasBeatRegen = Boolean(config.regenBeat);
  els.entityModalBeatField.hidden = !showBeat;
  if (showBeat && document.activeElement !== els.entityModalBeat) els.entityModalBeat.value = scene.beat || '';
  els.entityModalBeat.disabled = busy;

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

  const stale = type === 'prompt' && computeStaleness(scene).promptStale;
  els.entityModalStaleWarning.hidden = !stale;

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
  modal.addEventListener('click', (event) => { if (event.target === modal) modal.close(); });
  modal.addEventListener('close', () => {
    closeSceneAudioRecorder(els);
    modalState.historyAbortController?.abort();
    modalState.mediaAbortController?.abort();
    modalState.sceneId = null;
    modalState.type = null;
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
    import('./ui.js').then(({ openImageLibrary }) => {
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
    // Scene expansion is a deliberate storyboard-edit operation (see the "Expand into scenes"
    // action on the narration view), never an incidental side effect of regenerating an image —
    // this button always just regenerates, regardless of how long the scene's narration has grown.
    const confirmationOptions = modalState.type === 'video' ? { videoScene: scene, sceneIndex: index } : {};
    confirmRegeneration(`${verb} the ${config.title.toLowerCase()} for scene ${index + 1}? This creates a new version and makes it active.`, verb, confirmationOptions).then((confirmed) => {
      if (!confirmed) return;
      // Close immediately so the scene card's own spinner (driven by uiStore.operation, set
      // synchronously inside regenerate* before its first await) is visible right away, instead of
      // running invisibly behind a modal that never closes itself.
      els.entityModal.close();
      config.regen(index, els, (t) => els.statusText.textContent = t).then(refreshJobsAndRerenderScenes);
    });
  });

  els.entityModalExpandBtn.addEventListener('click', () => {
    const index = currentEntityModalSceneIndex();
    if (index === -1) return;
    const scene = sceneStore.get().scenes[index];
    const suggested = suggestSceneCountFromNarration([scene]);
    if (suggested <= 1) return;
    confirmRegeneration(`Split scene ${index + 1} into ${suggested} scenes based on its narration? This changes the storyboard structure — existing image/audio/video for this scene apply only to the first of the new scenes.`, 'Split').then((confirmed) => {
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
    const config = ENTITY_CONFIG[modalState.type];
    if (!config.regenBeat) return;
    const scene = sceneStore.get().scenes[index];
    const verb = Boolean(String(scene.beat || '').trim()) ? 'Regenerate' : 'Generate';
    confirmRegeneration(`${verb} the physical action for scene ${index + 1}? This does not change the visual prompt.`, verb).then((confirmed) => {
      if (confirmed) config.regenBeat(index, els, (t) => els.statusText.textContent = t).then(refreshJobsAndRerenderScenes);
    });
  });

  els.entityModalRegenTextBtn.addEventListener('click', () => {
    const index = currentEntityModalSceneIndex();
    if (index === -1) return;
    const config = ENTITY_CONFIG[modalState.type];
    const scene = sceneStore.get().scenes[index];
    const verb = hasExistingEntity(modalState.type, scene) ? 'Regenerate' : 'Generate';
    confirmRegeneration(`${verb} the ${(config.fieldLabel || config.title).toLowerCase()} for scene ${index + 1}? This replaces the current version.`, verb).then((confirmed) => {
      if (confirmed) config.regen(index, els, (t) => els.statusText.textContent = t).then(refreshJobsAndRerenderScenes);
    });
  });

  els.entityModalBeat.addEventListener('input', () => {
    const index = currentEntityModalSceneIndex();
    if (index === -1) return;
    const value = els.entityModalBeat.value;
    const scenes = sceneStore.get().scenes.map((scene, i) => (i === index ? { ...scene, beat: value } : scene));
    sceneStore.set({ scenes });
    const record = getCurrentStoryboardRecord();
    if (record) record.scenes = scenes;
    debouncedQueueSync();
  });

  els.entityModalTextarea.addEventListener('input', () => {
    const index = currentEntityModalSceneIndex();
    if (index === -1) return;
    const value = els.entityModalTextarea.value;
    const scenes = sceneStore.get().scenes.map((scene, i) => {
      if (i !== index) return scene;
      const next = { ...scene };
      ENTITY_CONFIG[modalState.type].setValue(next, value);
      return next;
    });
    sceneStore.set({ scenes });
    const record = getCurrentStoryboardRecord();
    if (record) record.scenes = scenes;
    debouncedQueueSync();
  });

  els.entityModalHistoryList.addEventListener('click', (event) => {
    const index = currentEntityModalSceneIndex();
    if (index === -1) return;
    const target = event.target.closest('.audio-version-select') || event.target.closest('.version-thumb');
    if (!target || target.disabled) return;
    const vIndex = parseInt(target.dataset.vindex, 10);
    const scenes = sceneStore.get().scenes.map((scene, i) => {
      if (i !== index) return scene;
      const next = { ...scene };
      ENTITY_CONFIG[modalState.type].selectVersion(next, vIndex);
      return next;
    });
    sceneStore.set({ scenes });
    const record = getCurrentStoryboardRecord();
    if (record) { record.scenes = scenes; queueSync(record); }
  });
}

export function initRendering(domEls) {
  els = domEls;
  setupConfirmModal();
  setupEntityModal();
  setupSceneReferencesModal();

  els.storyboardGrid.addEventListener('click', (e) => {
    const card = e.target.closest('.scene-card');
    if (!card) return;
    const sceneId = card.dataset.sceneId;
    const index = sceneStore.get().scenes.findIndex(s => s.id === sceneId);
    const scene = sceneStore.get().scenes[index];
    if (!scene) return;

    // Any interaction with a card — the card itself, its status icons, the library button —
    // selects it as the Start run's anchor, on top of whatever else the click does below. Locked
    // while a run is active (uiStore.operation set) so a stray click mid-run can't be mistaken for
    // changing the run's target — the run's range was already frozen at confirm time regardless, but
    // letting the visible "selected" card drift during a run reads as if the target changed. Once the
    // run stops, buildBatchFns's own progress tracking (stages.js) lands selection on wherever it
    // actually stopped, and manual selection is free again from there.
    if (uiStore.get().operation == null && uiStore.get().selectedSceneId !== scene.id) uiStore.set({ selectedSceneId: scene.id });

    const iconBtn = e.target.closest('.scene-status-icon');
    if (iconBtn && !iconBtn.disabled) {
      openEntityModal(index, iconBtn.dataset.status);
    }
  });

  sceneStore.subscribe(() => { renderScenes(); renderEntityModal(); renderSceneReferencesModal(); });
  generationStore.subscribe(() => renderSceneReferencesModal());
  uiStore.subscribe(() => { renderScenes(); renderEntityModal(); });
}

function setupScenePlayback({ toggle, video, audio, hasVideo, hasAudio, words, captionEl }) {
  let playing = false;
  let duration = 0;
  let currentTime = 0;
  let startedAt = 0;
  let animationFrame = null;

  const mediaDuration = (element, enabled) => enabled && Number.isFinite(element.duration) ? element.duration : 0;
  const setToggleState = (state) => {
    toggle.dataset.state = state;
    const action = state === 'playing' ? 'Pause' : state === 'ended' ? 'Replay' : 'Play';
    toggle.setAttribute('aria-label', `${action} scene`);
  };
  const updateDuration = () => {
    duration = Math.max(mediaDuration(video, hasVideo), mediaDuration(audio, hasAudio));
    toggle.disabled = duration <= 0;
    currentTime = Math.min(currentTime, duration || 0);
  };
  const positionMedia = (target, shouldPlay) => {
    const videoDuration = mediaDuration(video, hasVideo);
    const audioDuration = mediaDuration(audio, hasAudio);
    if (videoDuration) {
      const loopsForAudio = audioDuration > videoDuration;
      const videoTime = loopsForAudio ? target % videoDuration : Math.min(target, videoDuration);
      video.loop = loopsForAudio;
      if (Math.abs(video.currentTime - videoTime) > 0.15) video.currentTime = videoTime;
      if (shouldPlay && target < duration && (target < videoDuration || loopsForAudio)) video.play().catch(() => {});
      else video.pause();
    }
    if (audioDuration) {
      const audioTime = Math.min(target, audioDuration);
      if (Math.abs(audio.currentTime - audioTime) > 0.15) audio.currentTime = audioTime;
      if (shouldPlay && target < audioDuration) audio.play().catch(() => {});
      else audio.pause();
    }
  };
  const pause = () => {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = null;
    playing = false;
    video.pause();
    audio.pause();
    setToggleState(currentTime >= duration && duration ? 'ended' : 'paused');
    if (activeScenePlayback === controller) activeScenePlayback = null;
  };
  const tick = (now) => {
    currentTime = Math.min(duration, (now - startedAt) / 1000);
    if (captionEl) renderCaptionInto(captionEl, words, currentTime);
    if (currentTime >= duration) {
      positionMedia(duration, false);
      pause();
      return;
    }
    animationFrame = requestAnimationFrame(tick);
  };
  const play = () => {
    if (!duration) return;
    if (activeScenePlayback && activeScenePlayback !== controller) activeScenePlayback.pause();
    document.querySelectorAll('.audio-version-thumb audio').forEach((element) => element.pause());
    [els.timelineVideo, els.timelineAudio].forEach((element) => { if (element && !element.paused) element.pause(); });
    if (currentTime >= duration) currentTime = 0;
    activeScenePlayback = controller;
    playing = true;
    setToggleState('playing');
    startedAt = performance.now() - currentTime * 1000;
    positionMedia(currentTime, true);
    // Paint immediately rather than waiting for the first tick(), so resuming from a paused
    // mid-scene position doesn't show a stale (or missing) caption for one frame.
    if (captionEl) renderCaptionInto(captionEl, words, currentTime);
    animationFrame = requestAnimationFrame(tick);
  };
  const controller = {
    pause,
    cleanup() {
      pause();
      video.removeAttribute('src');
      video.load();
      audio.removeAttribute('src');
      audio.load();
      video.removeEventListener('loadedmetadata', updateDuration);
      video.removeEventListener('durationchange', updateDuration);
      audio.removeEventListener('loadedmetadata', updateDuration);
      audio.removeEventListener('durationchange', updateDuration);
      // A stale caption from this scene must not survive into whatever scene reuses this DOM node
      // next -- nodes are reused across renders (see renderScenes's existingNodesMap).
      if (captionEl) { captionEl.hidden = true; captionEl.textContent = ''; }
    },
  };

  toggle.hidden = !(hasVideo || hasAudio);
  toggle.disabled = true;
  video.loop = false;
  setToggleState('paused');
  video.addEventListener('loadedmetadata', updateDuration);
  video.addEventListener('durationchange', updateDuration);
  audio.addEventListener('loadedmetadata', updateDuration);
  audio.addEventListener('durationchange', updateDuration);
  toggle.addEventListener('click', () => { if (playing) pause(); else play(); });
  updateDuration();
  return controller.cleanup;
}

export function renderScenes() {
  const scenes = sceneStore.get().scenes;
  const operation = uiStore.get().operation;
  const selectedIndex = resolveSelectedSceneIndex(scenes, uiStore.get().selectedSceneId);

  els.storyboardSection.hidden = scenes.length === 0;


  const existingCards = Array.from(els.storyboardGrid.querySelectorAll('.scene-card'));
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

    sceneIndexEl.dataset.index = String(index + 1);
    titleEl.textContent = scene.title || `Scene ${index + 1}`;

    const busy = operation != null;
    const loadingByType = Object.fromEntries(Object.keys(ENTITY_CONFIG).map((type) => [type, isEntityLoading(type, scene, operation)]));

    const shot = imageShot(scene);
    const sceneStatus = {
      prompt: Boolean(String(scene.prompt || '').trim()),
      image: (scene.versions || []).some((version) => Boolean(version?.path)),
      dialogue: Boolean(String(scene.narrationText || '').trim()),
      audio: (scene.audioVersions || []).some((version) => Boolean(version?.path)),
      video: (shot.videoVersions || []).some((version) => Boolean(version?.path)),
      subtitle: (scene.subtitleVersions || []).some((version) => Boolean(version?.path)),
    };
    for (const [type, isPresent] of Object.entries(sceneStatus)) {
      const statusIcon = node.querySelector(`[data-status="${type}"]`);
      const isLoading = loadingByType[type];
      // A prior failed job only counts while nothing has superseded it — a scene that now has real
      // content (isPresent) succeeded since, and a fresh attempt in flight (isLoading) shouldn't
      // flash red for a not-yet-refreshed stale failure.
      const isFailed = !isPresent && !isLoading && latestJobsByStatus[type]?.get(scene.id)?.status === 'failed';
      const displayName = STATUS_LABELS[type] || `${type[0].toUpperCase()}${type.slice(1)}`;
      const label = isLoading
        ? `Generating ${displayName.toLowerCase()}...`
        : isFailed
          ? `${displayName} generation failed — click to retry`
          : `Configure ${displayName.toLowerCase()}`;
      statusIcon.classList.toggle('is-present', isPresent);
      statusIcon.classList.toggle('is-loading', isLoading);
      statusIcon.classList.toggle('is-failed', isFailed);
      statusIcon.disabled = busy;
      statusIcon.setAttribute('aria-label', label);
      statusIcon.title = label;
    }



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
}
