import { sceneStore, uiStore, debounce } from './store.js';
import { regeneratePrompt, regenerateDialogue, regenerateImage, regenerateAudio, regenerateVideo } from './workflows.js';
import { getCurrentStoryboardRecord, queueSync } from './persistence.js';
import { loadProtectedAsset } from './assets.js';
import { renderVoicesPanel } from './ui.js';
import { formatPlaybackTime } from './timeline.js';

let els = {};
let activeScenePlayback = null;
let scenePlaybackCleanups = [];
let confirmResolve = null;
let entityModalSceneId = null;
let entityModalType = null;
let entityModalMediaPath;

function linesToText(lines) {
  return (lines || []).map((line) => `${line.speaker || 'Narrator'}: ${line.text || ''}`).join('\n');
}
function textToLines(text) {
  return String(text || '').split('\n').map((row) => row.trim()).filter(Boolean).map((row) => {
    const colonIndex = row.indexOf(':');
    if (colonIndex === -1) return { speaker: 'Narrator', text: row };
    return { speaker: row.slice(0, colonIndex).trim() || 'Narrator', text: row.slice(colonIndex + 1).trim() };
  }).filter((line) => line.text);
}

const ENTITY_CONFIG = {
  prompt: {
    title: 'Visual Prompt',
    kind: 'text',
    fieldLabel: 'Visual prompt',
    getValue: (scene) => scene.prompt || '',
    setValue: (scene, value) => { scene.prompt = value; },
    regen: (index, els, cb) => regeneratePrompt(index, els, cb),
  },
  dialogue: {
    title: 'Dialogue',
    kind: 'text',
    fieldLabel: 'Dialogue',
    getValue: (scene) => linesToText(scene.lines),
    setValue: (scene, value) => { scene.lines = textToLines(value); },
    regen: (index, els, cb) => regenerateDialogue(index, els, cb),
  },
  image: {
    title: 'Image',
    kind: 'image',
    versions: (scene) => scene.versions,
    activeIndex: (scene) => scene.activeVersionIndex,
    selectVersion: (scene, vIndex) => { scene.activeVersionIndex = vIndex; scene.activeVisualType = 'image'; },
    regen: (index, els, cb) => regenerateImage(index, null, els, cb).catch(() => {}),
  },
  audio: {
    title: 'Audio',
    kind: 'audio',
    versions: (scene) => scene.audioVersions,
    activeIndex: (scene) => scene.activeAudioVersionIndex,
    selectVersion: (scene, vIndex) => { scene.activeAudioVersionIndex = vIndex; },
    regen: (index, els, cb) => regenerateAudio(index, null, els, cb).catch(() => {}),
  },
  video: {
    title: 'Video',
    kind: 'video',
    versions: (scene) => scene.videoVersions,
    activeIndex: (scene) => scene.activeVideoVersionIndex,
    selectVersion: (scene, vIndex) => { scene.activeVideoVersionIndex = vIndex; scene.activeVisualType = 'video'; },
    regen: (index, els, cb) => regenerateVideo(index, null, els, cb).catch(() => {}),
  },
};

function isEntityLoading(type, scene, operation) {
  if (!operation) return false;
  switch (type) {
    case 'prompt': return operation.type === 'prompts' || (operation.type === 'prompt' && operation.sceneId === scene.id);
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
    const resolve = confirmResolve;
    confirmResolve = null;
    if (resolve) resolve(confirmed);
  });
}

function confirmRegeneration(message) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    els.confirmRegenMessage.textContent = message;
    els.confirmRegenModal.showModal();
  });
}

function currentEntityModalSceneIndex() {
  if (!entityModalSceneId) return -1;
  return sceneStore.get().scenes.findIndex((s) => s.id === entityModalSceneId);
}

function openEntityModal(index, type) {
  const scene = sceneStore.get().scenes[index];
  if (!scene || !ENTITY_CONFIG[type]) return;
  entityModalSceneId = scene.id;
  entityModalType = type;
  entityModalMediaPath = undefined;
  els.entityModal.showModal();
  renderEntityModal();
}

function renderEntityModalMedia(scene, type, config) {
  const versions = config.versions(scene);
  const active = versions[config.activeIndex(scene)];
  const path = active?.path || null;
  els.entityModalMediaEmpty.hidden = Boolean(path);
  if (path === entityModalMediaPath) return; // unchanged — don't disrupt any in-progress playback
  entityModalMediaPath = path;

  els.entityModalImage.hidden = true;
  els.entityModalVideo.hidden = true;
  els.entityModalAudio.hidden = true;
  els.entityModalImage.removeAttribute('src');
  els.entityModalVideo.pause();
  els.entityModalVideo.removeAttribute('src');
  els.entityModalAudio.pause();
  els.entityModalAudio.removeAttribute('src');
  if (!path) return;

  if (type === 'image') {
    loadProtectedAsset(path).then((url) => { if (url) els.entityModalImage.src = url; });
    els.entityModalImage.hidden = false;
  } else if (type === 'video') {
    loadProtectedAsset(path).then((url) => { if (url) els.entityModalVideo.src = url; });
    els.entityModalVideo.hidden = false;
  } else if (type === 'audio') {
    loadProtectedAsset(path).then((url) => { if (url) els.entityModalAudio.src = url; });
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
      loadProtectedAsset(version.path).then((url) => { if (url) audio.src = url; });
      audio.addEventListener('play', () => activeScenePlayback?.pause());
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
    loadProtectedAsset(version.path).then((url) => { if (url) mediaEl.src = url; });
    const meta = document.createElement('div');
    meta.className = 'version-meta';
    meta.textContent = `v${vIndex + 1}`;
    btn.append(mediaEl, meta);
    els.entityModalHistoryList.appendChild(btn);
  });
}

function renderEntityModal() {
  if (!entityModalType || !els.entityModal.open) return;
  const index = currentEntityModalSceneIndex();
  if (index === -1) { els.entityModal.close(); return; }
  const scene = sceneStore.get().scenes[index];
  const type = entityModalType;
  const config = ENTITY_CONFIG[type];
  const operation = uiStore.get().operation;
  const busy = operation != null;
  const isLoading = isEntityLoading(type, scene, operation);

  els.entityModalSceneLabel.textContent = `Scene ${index + 1}`;
  els.entityModalTitle.textContent = config.title;

  const showBeat = type === 'prompt';
  els.entityModalBeatField.hidden = !showBeat;
  if (showBeat && document.activeElement !== els.entityModalBeat) els.entityModalBeat.value = scene.beat || '';
  els.entityModalBeat.disabled = busy;

  const isText = config.kind === 'text';
  els.entityModalTextField.hidden = !isText;
  els.entityModalTextFieldLabel.textContent = config.fieldLabel || '';
  if (isText && document.activeElement !== els.entityModalTextarea) els.entityModalTextarea.value = config.getValue(scene);
  els.entityModalTextarea.disabled = busy;
  els.entityModalTextHint.hidden = type !== 'dialogue';

  els.entityModalMedia.hidden = isText;
  if (!isText) renderEntityModalMedia(scene, type, config);

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

  els.closeEntityModalBtn.addEventListener('click', () => modal.close());
  modal.addEventListener('click', (event) => { if (event.target === modal) modal.close(); });
  modal.addEventListener('close', () => {
    entityModalSceneId = null;
    entityModalType = null;
    entityModalMediaPath = undefined;
    els.entityModalVideo.pause();
    els.entityModalVideo.removeAttribute('src');
    els.entityModalAudio.pause();
    els.entityModalAudio.removeAttribute('src');
    els.entityModalImage.removeAttribute('src');
  });

  els.entityModalRegenBtn.addEventListener('click', () => {
    const index = currentEntityModalSceneIndex();
    if (index === -1) return;
    const config = ENTITY_CONFIG[entityModalType];
    confirmRegeneration(`Regenerate the ${config.title.toLowerCase()} for scene ${index + 1}? This replaces the current version.`).then((confirmed) => {
      if (confirmed) config.regen(index, els, (t) => els.statusText.textContent = t);
    });
  });

  els.entityModalBeat.addEventListener('input', debounce(() => {
    const index = currentEntityModalSceneIndex();
    if (index === -1) return;
    const scenes = sceneStore.get().scenes;
    scenes[index].beat = els.entityModalBeat.value;
    sceneStore.set({ scenes: [...scenes] });
    const record = getCurrentStoryboardRecord();
    if (record) { record.scenes = sceneStore.get().scenes; queueSync(record, (t) => els.statusText.textContent = t); }
  }, 500));

  els.entityModalTextarea.addEventListener('input', debounce(() => {
    const index = currentEntityModalSceneIndex();
    if (index === -1) return;
    const scenes = sceneStore.get().scenes;
    ENTITY_CONFIG[entityModalType].setValue(scenes[index], els.entityModalTextarea.value);
    sceneStore.set({ scenes: [...scenes] });
    const record = getCurrentStoryboardRecord();
    if (record) { record.scenes = sceneStore.get().scenes; queueSync(record, (t) => els.statusText.textContent = t); }
    if (entityModalType === 'dialogue') renderVoicesPanel(els, (t) => els.statusText.textContent = t);
  }, 500));

  els.entityModalHistoryList.addEventListener('click', (event) => {
    const index = currentEntityModalSceneIndex();
    if (index === -1) return;
    const target = event.target.closest('.audio-version-select') || event.target.closest('.version-thumb');
    if (!target || target.disabled) return;
    const scenes = sceneStore.get().scenes;
    ENTITY_CONFIG[entityModalType].selectVersion(scenes[index], parseInt(target.dataset.vindex, 10));
    sceneStore.set({ scenes: [...scenes] });
    const record = getCurrentStoryboardRecord();
    if (record) { record.scenes = sceneStore.get().scenes; queueSync(record); }
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
  els.storyboardGrid.innerHTML = '';
  for (let index = 0; index < count; index++) {
    const target = document.createElement('article');
    target.className = 'scene-card scene-card-loading';
    target.innerHTML = `<div class="scene-index">Scene ${index + 1}</div><div class="empty-image-target"></div><div class="empty-prompt-target"><span class="spinner"></span><span>Generating prompt</span></div>`;
    els.storyboardGrid.appendChild(target);
  }
}

function setupScenePlayback({ container, toggle, timeline, timeLabel, video, audio, hasVideo, hasAudio }) {
  let playing = false;
  let duration = 0;
  let currentTime = 0;
  let startedAt = 0;
  let animationFrame = null;

  const mediaDuration = (element, enabled) => enabled && Number.isFinite(element.duration) ? element.duration : 0;
  const updateDisplay = () => {
    timeline.value = String(currentTime);
    timeLabel.textContent = `${formatPlaybackTime(currentTime)} / ${formatPlaybackTime(duration)}`;
  };
  const updateDuration = () => {
    duration = Math.max(mediaDuration(video, hasVideo), mediaDuration(audio, hasAudio));
    timeline.max = String(duration || 0);
    timeline.disabled = duration <= 0;
    toggle.disabled = duration <= 0;
    currentTime = Math.min(currentTime, duration || 0);
    updateDisplay();
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
    toggle.textContent = currentTime >= duration && duration ? 'Replay' : 'Play';
    toggle.setAttribute('aria-label', toggle.textContent === 'Replay' ? 'Replay combined scene' : 'Play combined scene');
    if (activeScenePlayback === controller) activeScenePlayback = null;
  };
  const tick = (now) => {
    currentTime = Math.min(duration, (now - startedAt) / 1000);
    updateDisplay();
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
    toggle.textContent = 'Pause';
    toggle.setAttribute('aria-label', 'Pause combined scene');
    startedAt = performance.now() - currentTime * 1000;
    positionMedia(currentTime, true);
    animationFrame = requestAnimationFrame(tick);
  };
  const controller = {
    pause,
    cleanup() {
      pause();
      video.removeAttribute('src');
      audio.removeAttribute('src');
    },
  };

  container.hidden = !(hasVideo || hasAudio);
  timeline.disabled = true;
  toggle.disabled = true;
  video.addEventListener('loadedmetadata', updateDuration);
  video.addEventListener('durationchange', updateDuration);
  audio.addEventListener('loadedmetadata', updateDuration);
  audio.addEventListener('durationchange', updateDuration);
  toggle.addEventListener('click', () => { if (playing) pause(); else play(); });
  timeline.addEventListener('input', () => {
    currentTime = Number(timeline.value) || 0;
    if (playing) startedAt = performance.now() - currentTime * 1000;
    positionMedia(currentTime, playing);
    updateDisplay();
  });
  updateDuration();
  return controller.cleanup;
}

export function renderScenes() {
  scenePlaybackCleanups.forEach((cleanup) => cleanup());
  scenePlaybackCleanups = [];
  const scenes = sceneStore.get().scenes;
  const operation = uiStore.get().operation;
  
  if (!scenes.length && operation?.type === 'prompts') {
    renderEmptyPromptTargets();
    return;
  }
  
  els.storyboardGrid.innerHTML = '';

  scenes.forEach((scene, index) => {
    const node = els.sceneCardTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.sceneId = scene.id;

    const sceneIndexEl = node.querySelector('.scene-index');
    const titleEl = node.querySelector('.scene-title');
    const imageEl = node.querySelector('.scene-image');
    const videoEl = node.querySelector('.scene-video');
    const placeholderEl = node.querySelector('.scene-placeholder');
    const playbackEl = node.querySelector('.scene-playback');
    const playbackToggleEl = node.querySelector('.scene-playback-toggle');
    const playbackTimelineEl = node.querySelector('.scene-playback-timeline');
    const playbackTimeEl = node.querySelector('.scene-playback-time');
    const playbackAudioEl = node.querySelector('.scene-playback-audio');

    sceneIndexEl.dataset.index = String(index + 1);
    titleEl.textContent = scene.title || `Scene ${index + 1}`;

    const busy = operation != null;
    const loadingByType = Object.fromEntries(Object.keys(ENTITY_CONFIG).map((type) => [type, isEntityLoading(type, scene, operation)]));

    const sceneStatus = {
      prompt: Boolean(String(scene.prompt || '').trim()),
      image: (scene.versions || []).some((version) => Boolean(version?.path)),
      dialogue: (scene.lines || []).some((line) => Boolean(String(line?.text || '').trim())),
      audio: (scene.audioVersions || []).some((version) => Boolean(version?.path)),
      video: (scene.videoVersions || []).some((version) => Boolean(version?.path)),
    };
    for (const [type, isPresent] of Object.entries(sceneStatus)) {
      const statusIcon = node.querySelector(`[data-status="${type}"]`);
      const isLoading = loadingByType[type];
      const label = isLoading
        ? `Regenerating ${type}...`
        : isPresent
          ? `Regenerate ${type}`
          : `${type[0].toUpperCase()}${type.slice(1)} missing`;
      statusIcon.classList.toggle('is-present', isPresent);
      statusIcon.classList.toggle('is-loading', isLoading);
      statusIcon.disabled = !isPresent || busy;
      statusIcon.setAttribute('aria-label', label);
      statusIcon.title = label;
    }

    const activeVersion = scene.versions[scene.activeVersionIndex];
    const activeVideoVersion = scene.videoVersions[scene.activeVideoVersionIndex];

    if (scene.activeVisualType === 'video' && activeVideoVersion?.path) {
      loadProtectedAsset(activeVideoVersion.path).then(url => { if (url) videoEl.src = url; });
      if (activeVersion?.path) {
        loadProtectedAsset(activeVersion.path).then(url => { if (url) videoEl.poster = url; });
      }
      videoEl.style.display = 'block';
      imageEl.removeAttribute('src');
      imageEl.style.display = 'none';
      placeholderEl.style.display = 'none';
    } else if (activeVersion?.path) {
      loadProtectedAsset(activeVersion.path).then(url => { if (url) imageEl.src = url; });
      imageEl.style.display = 'block';
      videoEl.removeAttribute('src');
      videoEl.style.display = 'none';
      placeholderEl.style.display = 'none';
    } else {
      imageEl.removeAttribute('src');
      imageEl.style.display = 'none';
      videoEl.removeAttribute('src');
      videoEl.style.display = 'none';
      placeholderEl.style.display = 'flex';
    }

    const activeAudioVersion = scene.audioVersions[scene.activeAudioVersionIndex];
    if (activeAudioVersion?.path) {
      loadProtectedAsset(activeAudioVersion.path).then(url => { if (url) playbackAudioEl.src = url; });
    }

    scenePlaybackCleanups.push(setupScenePlayback({
      container: playbackEl,
      toggle: playbackToggleEl,
      timeline: playbackTimelineEl,
      timeLabel: playbackTimeEl,
      video: videoEl,
      audio: playbackAudioEl,
      hasVideo: scene.activeVisualType === 'video' && Boolean(activeVideoVersion?.path),
      hasAudio: Boolean(activeAudioVersion?.path),
    }));

    node.classList.toggle('is-busy', Object.values(loadingByType).some(Boolean));
    node.querySelector('.image-loading').classList.toggle('visible', loadingByType.image);
    node.querySelector('.video-loading').classList.toggle('visible', loadingByType.video);

    els.storyboardGrid.appendChild(node);
  });
}
