import { sceneStore, uiStore, debounce } from './store.js';
import { regeneratePrompt, regenerateAction, regenerateDialogue, regenerateImage, regenerateAudio, regenerateVideo } from './workflows.js';
import { getCurrentStoryboardRecord, queueSync } from './persistence.js';
import { loadProtectedAsset } from './assets.js';

let els = {};
let activeScenePlayback = null;
let scenePlaybackCleanups = new Map();
let renderAbortController = null;

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

const STATUS_LABELS = { dialogue: 'Narration' };

const handleAssetError = (err) => {
  if (err.name !== 'AbortError') console.error('Asset load error:', err);
};

const ENTITY_CONFIG = {
  prompt: {
    title: 'Visual Prompt',
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
    regen: (index, els, cb) => regenerateImage(index, null, els, cb).catch(() => {}),
  },
  audio: {
    title: 'Audio',
    kind: 'audio',
    versions: (scene) => scene.audioVersions || [],
    activeIndex: (scene) => scene.activeAudioVersionIndex,
    selectVersion: (scene, vIndex) => { scene.activeAudioVersionIndex = vIndex; },
    regen: (index, els, cb) => regenerateAudio(index, null, els, cb).catch(() => {}),
  },
  video: {
    title: 'Video',
    kind: 'video',
    versions: (scene) => scene.videoVersions || [],
    activeIndex: (scene) => scene.activeVideoVersionIndex,
    selectVersion: (scene, vIndex) => { scene.activeVideoVersionIndex = vIndex; scene.activeVisualType = 'video'; },
    regen: (index, els, cb) => regenerateVideo(index, null, els, cb).catch(() => {}),
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

  const stale = type === 'prompt' && Boolean(scene.beat) && Boolean(scene.promptGeneratedFromBeat) && scene.beat !== scene.promptGeneratedFromBeat;
  els.entityModalStaleWarning.hidden = !stale;

  els.entityModalRegenBtn.hidden = isText;
  els.entityModalRegenBtn.disabled = busy;
  els.entityModalRegenBtn.classList.toggle('is-loading', isLoading);
  els.entityModalRegenBtn.textContent = isLoading ? 'Regenerating' : 'Regenerate';
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

  els.entityModalRegenBtn.addEventListener('click', () => {
    const index = currentEntityModalSceneIndex();
    if (index === -1) return;
    const config = ENTITY_CONFIG[modalState.type];
    confirmRegeneration(`Regenerate the ${config.title.toLowerCase()} for scene ${index + 1}? This creates a new version and makes it active.`).then((confirmed) => {
      if (confirmed) config.regen(index, els, (t) => els.statusText.textContent = t);
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

  els.storyboardGrid.addEventListener('click', (e) => {
    const card = e.target.closest('.scene-card');
    if (!card) return;
    const sceneId = card.dataset.sceneId;
    const index = sceneStore.get().scenes.findIndex(s => s.id === sceneId);
    const scene = sceneStore.get().scenes[index];
    if (!scene) return;

    const iconBtn = e.target.closest('.scene-status-icon');
    if (iconBtn && !iconBtn.disabled) openEntityModal(index, iconBtn.dataset.status);
  });

  sceneStore.subscribe(() => { renderScenes(); renderEntityModal(); });
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
  renderAbortController?.abort();
  renderAbortController = new AbortController();
  const signal = renderAbortController.signal;

  const scenes = sceneStore.get().scenes;
  const operation = uiStore.get().operation;
  
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
        ? `Regenerating ${displayName.toLowerCase()}...`
        : isPresent
          ? `Regenerate ${displayName.toLowerCase()}`
          : `${displayName} missing`;
      statusIcon.classList.toggle('is-present', isPresent);
      statusIcon.classList.toggle('is-loading', isLoading);
      statusIcon.disabled = !isPresent || busy;
      statusIcon.setAttribute('aria-label', label);
      statusIcon.title = label;
    }

    const activeVersion = scene.versions?.[scene.activeVersionIndex];
    const activeVideoVersion = scene.videoVersions?.[scene.activeVideoVersionIndex];
    const currentVideoPath = activeVideoVersion?.path || '';
    const currentPosterPath = activeVersion?.path || '';

    if (scene.activeVisualType === 'video' && currentVideoPath) {
      if (videoEl.dataset.assetPath !== currentVideoPath) {
        videoEl.dataset.assetPath = currentVideoPath;
        loadProtectedAsset(currentVideoPath, { signal }).then(url => { if (url && videoEl.dataset.assetPath === currentVideoPath) videoEl.src = url; }).catch(handleAssetError);
      }
      if (currentPosterPath && videoEl.dataset.posterPath !== currentPosterPath) {
        videoEl.dataset.posterPath = currentPosterPath;
        loadProtectedAsset(currentPosterPath, { signal }).then(url => { if (url && videoEl.dataset.posterPath === currentPosterPath) videoEl.poster = url; }).catch(handleAssetError);
      }
      videoEl.style.display = 'block';
      imageEl.removeAttribute('src');
      imageEl.dataset.assetPath = '';
      imageEl.style.display = 'none';
      placeholderEl.style.display = 'none';
    } else if (currentPosterPath) {
      if (imageEl.dataset.assetPath !== currentPosterPath) {
        imageEl.dataset.assetPath = currentPosterPath;
        loadProtectedAsset(currentPosterPath, { signal }).then(url => { if (url && imageEl.dataset.assetPath === currentPosterPath) imageEl.src = url; }).catch(handleAssetError);
      }
      imageEl.style.display = 'block';
      videoEl.removeAttribute('src');
      videoEl.removeAttribute('poster');
      videoEl.dataset.assetPath = '';
      videoEl.dataset.posterPath = '';
      videoEl.style.display = 'none';
      videoEl.load();
      placeholderEl.style.display = 'none';
    } else {
      imageEl.removeAttribute('src');
      imageEl.dataset.assetPath = '';
      imageEl.style.display = 'none';
      videoEl.removeAttribute('src');
      videoEl.removeAttribute('poster');
      videoEl.dataset.assetPath = '';
      videoEl.dataset.posterPath = '';
      videoEl.style.display = 'none';
      videoEl.load();
      placeholderEl.style.display = 'flex';
    }

    const activeAudioVersion = scene.audioVersions?.[scene.activeAudioVersionIndex];
    const currentAudioPath = activeAudioVersion?.path || '';
    if (currentAudioPath && playbackAudioEl.dataset.assetPath !== currentAudioPath) {
      playbackAudioEl.dataset.assetPath = currentAudioPath;
      loadProtectedAsset(currentAudioPath, { signal }).then(url => { if (url && playbackAudioEl.dataset.assetPath === currentAudioPath) playbackAudioEl.src = url; }).catch(handleAssetError);
    } else if (!currentAudioPath) {
      playbackAudioEl.removeAttribute('src');
      playbackAudioEl.dataset.assetPath = '';
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
