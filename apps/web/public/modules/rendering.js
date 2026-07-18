import { sceneStore, generationStore, uiStore, debounce } from './store.js';
import { regeneratePrompt, regenerateAction, regenerateDialogue, regenerateImage, regenerateAudio, regenerateVideo, splitSceneInPlace } from './workflows.js';
import { ensureProjectSynced, getCurrentStoryboardRecord, persistStoryboardLibrary, queueSync } from './persistence.js';
import { loadProtectedAsset } from './assets.js';
import { api } from './api.js';
import { suggestSceneCountFromNarration } from './scene-count.js';
import { computeStaleness, resolveSelectedSceneIndex } from './stages.js';

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
    getValue: (scene) => scene.prompt || '',
    setValue: (scene, value) => { scene.prompt = value; },
    regen: (index, els, cb) => regeneratePrompt(index, els, cb),
    regenBeat: (index, els, cb) => regenerateAction(index, els, cb),
  },
  dialogue: {
    title: 'Spoken Narration',
    kind: 'text',
    fieldLabel: 'Spoken Narration',
    getValue: (scene) => scene.narrationText || '',
    setValue: (scene, value) => { scene.narrationText = value; scene.narrationIsFallback = false; },
    regen: (index, els, cb) => regenerateDialogue(index, els, cb, els.entityModalInstruction?.value.trim() || ''),
  },
  image: {
    title: 'Image',
    kind: 'image',
    versions: (scene) => scene.versions || [],
    activeIndex: (scene) => scene.activeVersionIndex,
    selectVersion: (scene, vIndex) => { scene.activeVersionIndex = vIndex; scene.activeVisualType = 'image'; },
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
    versions: (scene) => scene.videoVersions || [],
    activeIndex: (scene) => scene.activeVideoVersionIndex,
    selectVersion: (scene, vIndex) => { scene.activeVideoVersionIndex = vIndex; scene.activeVisualType = 'video'; },
    regen: (index, els, cb) => regenerateVideo(index, null, els, cb).catch((error) => cb(error.message)),
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
    default: return false;
  }
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
    const resolve = modalState.confirmResolve;
    modalState.confirmResolve = null;
    if (resolve) resolve(confirmed);
  });
}

function confirmRegeneration(message) {
  return new Promise((resolve) => {
    modalState.confirmResolve = resolve;
    els.confirmRegenMessage.textContent = message;
    els.confirmRegenModal.showModal();
  });
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
  const disabled = new Set(scene.disabledProjectReferenceImages || []);
  const defaults = Object.values(generationStore.get().styleReferences || {}).flat();
  const uploaded = scene.referenceImages || [];
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
    const text = document.createElement('span'); text.textContent = item.fileName || 'Scene reference'; name.appendChild(text);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'ref-delete-btn'; remove.textContent = '×';
    remove.dataset.sceneReferencePath = item.path; remove.setAttribute('aria-label', `Delete ${item.fileName || 'scene reference'}`);
    card.append(referenceImage(item.path, item.fileName || 'Scene reference'), name, remove);
    els.sceneUploadedReferences.appendChild(card);
  });
  els.sceneReferenceInput.disabled = uploaded.length >= 8;
}

function replaceSceneFromReferenceResponse(data) {
  const scenes = sceneStore.get().scenes.map((scene) => scene.id === data.scene.id ? data.scene : scene);
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
      const disabled = new Set(scene.disabledProjectReferenceImages || []);
      if (checkbox.checked) disabled.delete(url); else disabled.add(url);
      return { ...scene, disabledProjectReferenceImages: [...disabled] };
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
  }
}

function renderEntityModalHistory(scene, type, config, busy) {
  if (config.kind === 'text') { els.entityModalHistory.hidden = true; return; }
  const versions = config.versions(scene);
  const activeIdx = config.activeIndex(scene);
  els.entityModalHistory.hidden = versions.length === 0;
  els.entityModalHistoryCount.textContent = `${versions.length} version${versions.length === 1 ? '' : 's'}`;
  els.entityModalHistoryList.className = type === 'audio' ? 'audio-version-list' : 'version-list';
  els.entityModalHistoryList.innerHTML = '';
  modalState.historyAbortController?.abort();
  modalState.historyAbortController = new AbortController();
  const signal = modalState.historyAbortController.signal;

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
    meta.textContent = `v${vIndex + 1}`;
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

  els.entityModalMedia.hidden = isText;
  if (!isText) renderEntityModalMedia(scene, type, config);

  const beatLoading = isEntityLoading('action', scene, operation);
  const promptFieldLoading = type === 'prompt'
    ? (operation?.type === 'prompts' || (operation?.type === 'prompt' && operation.sceneId === scene.id))
    : isLoading;
  els.entityModalRegenBeatBtn.hidden = !(showBeat && hasBeatRegen);
  els.entityModalRegenBeatBtn.disabled = busy;
  els.entityModalRegenBeatBtn.classList.toggle('is-loading', beatLoading);
  els.entityModalRegenBeatBtn.textContent = beatLoading ? 'Regenerating…' : 'Regenerate';

  els.entityModalRegenTextBtn.hidden = !isText;
  els.entityModalRegenTextBtn.disabled = busy;
  els.entityModalRegenTextBtn.classList.toggle('is-loading', promptFieldLoading);
  els.entityModalRegenTextBtn.textContent = promptFieldLoading ? 'Regenerating…' : 'Regenerate';

  const stale = type === 'prompt' && computeStaleness(scene).promptStale;
  els.entityModalStaleWarning.hidden = !stale;

  els.entityModalRegenBtn.hidden = isText;
  els.entityModalRegenBtn.disabled = busy;
  els.entityModalRegenBtn.classList.toggle('is-loading', isLoading);
  els.entityModalRegenBtn.textContent = isLoading ? 'Regenerating' : 'Regenerate';

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

  els.entityModalStatus.textContent = isLoading ? 'Regeneration in progress…' : (busy ? 'Another operation is running…' : '');

  renderEntityModalHistory(scene, type, config, busy);
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

  // Capture play events on the history list for delegation
  els.entityModalHistoryList.addEventListener('play', (e) => {
    if (e.target.tagName === 'AUDIO') {
      activeScenePlayback?.pause();
    }
  }, true);

  els.closeEntityModalBtn.addEventListener('click', () => modal.close());
  modal.addEventListener('click', (event) => { if (event.target === modal) modal.close(); });
  modal.addEventListener('close', () => {
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

  els.entityModalRegenBtn.addEventListener('click', () => {
    const index = currentEntityModalSceneIndex();
    if (index === -1) return;
    const config = ENTITY_CONFIG[modalState.type];
    // Scene expansion is a deliberate storyboard-edit operation (see the "Expand into scenes"
    // action on the narration view), never an incidental side effect of regenerating an image —
    // this button always just regenerates, regardless of how long the scene's narration has grown.
    confirmRegeneration(`Regenerate the ${config.title.toLowerCase()} for scene ${index + 1}? This creates a new version and makes it active.`).then((confirmed) => {
      if (!confirmed) return;
      // Close immediately so the scene card's own spinner (driven by uiStore.operation, set
      // synchronously inside regenerate* before its first await) is visible right away, instead of
      // running invisibly behind a modal that never closes itself.
      els.entityModal.close();
      config.regen(index, els, (t) => els.statusText.textContent = t);
    });
  });

  els.entityModalExpandBtn.addEventListener('click', () => {
    const index = currentEntityModalSceneIndex();
    if (index === -1) return;
    const scene = sceneStore.get().scenes[index];
    const suggested = suggestSceneCountFromNarration([scene]);
    if (suggested <= 1) return;
    confirmRegeneration(`Split scene ${index + 1} into ${suggested} scenes based on its narration? This changes the storyboard structure — existing image/audio/video for this scene apply only to the first of the new scenes.`).then((confirmed) => {
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
    confirmRegeneration(`Regenerate the physical action for scene ${index + 1}? This does not change the visual prompt.`).then((confirmed) => {
      if (confirmed) config.regenBeat(index, els, (t) => els.statusText.textContent = t);
    });
  });

  els.entityModalRegenTextBtn.addEventListener('click', () => {
    const index = currentEntityModalSceneIndex();
    if (index === -1) return;
    const config = ENTITY_CONFIG[modalState.type];
    confirmRegeneration(`Regenerate the ${(config.fieldLabel || config.title).toLowerCase()} for scene ${index + 1}? This replaces the current version.`).then((confirmed) => {
      if (confirmed) config.regen(index, els, (t) => els.statusText.textContent = t);
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
      if (iconBtn.dataset.status === 'reference') openSceneReferencesModal(index);
      else openEntityModal(index, iconBtn.dataset.status);
    }
  });

  sceneStore.subscribe(() => { renderScenes(); renderEntityModal(); renderSceneReferencesModal(); });
  generationStore.subscribe(() => renderSceneReferencesModal());
  uiStore.subscribe(() => { renderScenes(); renderEntityModal(); });
}

function renderEmptyPromptTargets() {
  const count = Math.min(50, Math.max(1, Number(els.sceneCount.value) || 1));
  const nodes = [];
  for (let index = 0; index < count; index++) {
    const target = document.createElement('article');
    target.className = 'scene-card scene-card-loading';
    target.innerHTML = `<div class="scene-index">Scene ${index + 1}</div><div class="empty-image-target"></div><div class="empty-prompt-target"><span class="spinner"></span><span>Generating prompt</span></div>`;
    nodes.push(target);
  }
  els.storyboardGrid.replaceChildren(...nodes);
}

function setupScenePlayback({ toggle, video, audio, hasVideo, hasAudio }) {
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

  els.storyboardSection.hidden = scenes.length === 0 && operation?.type !== 'prompts';

  if (!scenes.length && operation?.type === 'prompts') {
    scenePlaybackCleanups.forEach(cleanup => cleanup());
    scenePlaybackCleanups.clear();
    renderEmptyPromptTargets();
    return;
  }
  
  const existingCards = Array.from(els.storyboardGrid.querySelectorAll('.scene-card'));
  const existingNodesMap = new Map(existingCards.map(node => [node.dataset.sceneId, node]));
  
  const nextScenePlaybackCleanups = new Map();
  const nextNodes = [];

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

    const sceneStatus = {
      prompt: Boolean(String(scene.prompt || '').trim()),
      image: (scene.versions || []).some((version) => Boolean(version?.path)),
      dialogue: Boolean(String(scene.narrationText || '').trim()),
      audio: (scene.audioVersions || []).some((version) => Boolean(version?.path)),
      video: (scene.videoVersions || []).some((version) => Boolean(version?.path)),
    };
    for (const [type, isPresent] of Object.entries(sceneStatus)) {
      const statusIcon = node.querySelector(`[data-status="${type}"]`);
      const isLoading = loadingByType[type];
      const displayName = STATUS_LABELS[type] || `${type[0].toUpperCase()}${type.slice(1)}`;
      const label = isLoading
        ? `Generating ${displayName.toLowerCase()}...`
        : `Configure ${displayName.toLowerCase()}`;
      statusIcon.classList.toggle('is-present', isPresent);
      statusIcon.classList.toggle('is-loading', isLoading);
      statusIcon.disabled = busy;
      statusIcon.setAttribute('aria-label', label);
      statusIcon.title = label;
    }

    const referenceIcon = node.querySelector('[data-status="reference"]');
    const defaultReferenceCount = Object.values(generationStore.get().styleReferences || {}).flat().filter((item) => !(scene.disabledProjectReferenceImages || []).includes(item.url)).length;
    const sceneReferenceCount = (scene.referenceImages || []).length;
    const referenceCount = defaultReferenceCount + sceneReferenceCount;
    referenceIcon.classList.add('is-present');
    referenceIcon.classList.toggle('has-scene-references', sceneReferenceCount > 0 || (scene.disabledProjectReferenceImages || []).length > 0);
    referenceIcon.disabled = busy;
    referenceIcon.setAttribute('aria-label', `Scene references: ${referenceCount} active`);
    referenceIcon.title = `${referenceCount} active reference image${referenceCount === 1 ? '' : 's'} · ${sceneReferenceCount} scene-only`;

    const activeVersion = scene.versions?.[scene.activeVersionIndex];
    const activeVideoVersion = scene.videoVersions?.[scene.activeVideoVersionIndex];
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

    const hasVideo = scene.activeVisualType === 'video' && Boolean(currentVideoPath);
    const hasAudio = Boolean(currentAudioPath);
    const playbackKey = `${hasVideo}-${currentVideoPath}-${hasAudio}-${currentAudioPath}`;
    
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
