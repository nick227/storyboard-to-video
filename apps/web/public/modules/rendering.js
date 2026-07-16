import { sceneStore, uiStore, debounce } from './store.js';
import { regeneratePrompt, regenerateDialogue, regenerateImage, regenerateAudio, regenerateVideo } from './workflows.js';
import { getCurrentStoryboardRecord, queueSync } from './persistence.js';
import { loadProtectedAsset } from './assets.js';
import { renderVoicesPanel } from './ui.js';
import { formatPlaybackTime } from './timeline.js';

let els = {};
let activeScenePlayback = null;
let scenePlaybackCleanups = [];

export function initRendering(domEls) {
  els = domEls;
  
  els.storyboardGrid.addEventListener('input', debounce((e) => {
    const card = e.target.closest('.scene-card');
    if (!card) return;
    const sceneId = card.dataset.sceneId;
    const scene = sceneStore.get().scenes.find(s => s.id === sceneId);
    if (!scene) return;
    
    let changed = false;
    if (e.target.classList.contains('scene-title-input')) {
      scene.title = e.target.value; changed = true;
    } else if (e.target.classList.contains('scene-beat')) {
      scene.beat = e.target.value; changed = true;
    } else if (e.target.classList.contains('scene-prompt')) {
      scene.prompt = e.target.value; changed = true;
    } else if (e.target.classList.contains('scene-dialogue')) {
      const text = e.target.value;
      scene.lines = String(text || '').split('\n').map((row) => row.trim()).filter(Boolean).map((row) => {
        const colonIndex = row.indexOf(':');
        if (colonIndex === -1) return { speaker: 'Narrator', text: row };
        return { speaker: row.slice(0, colonIndex).trim() || 'Narrator', text: row.slice(colonIndex + 1).trim() };
      }).filter((line) => line.text);
      changed = true;
      renderVoicesPanel(els, (text) => els.statusText.textContent = text);
    }
    
    if (changed) {
      sceneStore.set({ scenes: [...sceneStore.get().scenes] });
      const record = getCurrentStoryboardRecord();
      if (record) {
        record.scenes = sceneStore.get().scenes;
        queueSync(record, (text) => els.statusText.textContent = text);
      }
    }
  }, 500));

  els.storyboardGrid.addEventListener('click', (e) => {
    const card = e.target.closest('.scene-card');
    if (!card) return;
    const sceneId = card.dataset.sceneId;
    const index = sceneStore.get().scenes.findIndex(s => s.id === sceneId);
    const scene = sceneStore.get().scenes[index];
    if (!scene) return;
    
    if (e.target.classList.contains('regen-prompt-btn')) {
      regeneratePrompt(index, els, (t) => els.statusText.textContent = t);
    } else if (e.target.classList.contains('regen-image-btn')) {
      regenerateImage(index, null, els, (t) => els.statusText.textContent = t).catch(() => {});
    } else if (e.target.classList.contains('regen-video-btn')) {
      regenerateVideo(index, null, els, (t) => els.statusText.textContent = t).catch(() => {});
    } else if (e.target.classList.contains('regen-dialogue-btn')) {
      regenerateDialogue(index, els, (t) => els.statusText.textContent = t);
    } else if (e.target.classList.contains('regen-audio-btn')) {
      regenerateAudio(index, null, els, (t) => els.statusText.textContent = t).catch(() => {});
    } else if (e.target.closest('.version-thumb')) {
      const btn = e.target.closest('.version-thumb');
      const vIndex = parseInt(btn.dataset.vindex, 10);
      const isVideo = btn.dataset.type === 'video';
      if (isVideo) {
        scene.activeVideoVersionIndex = vIndex;
        scene.activeVisualType = 'video';
      } else {
        scene.activeVersionIndex = vIndex;
        scene.activeVisualType = 'image';
      }
      sceneStore.set({ scenes: [...sceneStore.get().scenes] });
      const record = getCurrentStoryboardRecord();
      if (record) { record.scenes = sceneStore.get().scenes; queueSync(record); }
    } else if (e.target.closest('.audio-version-select')) {
      const btn = e.target.closest('.audio-version-select');
      const vIndex = parseInt(btn.dataset.vindex, 10);
      scene.activeAudioVersionIndex = vIndex;
      sceneStore.set({ scenes: [...sceneStore.get().scenes] });
      const record = getCurrentStoryboardRecord();
      if (record) { record.scenes = sceneStore.get().scenes; queueSync(record); }
    }
  });
  
  sceneStore.subscribe(() => renderScenes());
  uiStore.subscribe(() => renderScenes());
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
    const titleInput = node.querySelector('.scene-title-input');
    const beatEl = node.querySelector('.scene-beat');
    const promptEl = node.querySelector('.scene-prompt');
    const imageEl = node.querySelector('.scene-image');
    const videoEl = node.querySelector('.scene-video');
    const placeholderEl = node.querySelector('.scene-placeholder');
    const imageVersionListEl = node.querySelector('.image-version-list');
    const videoVersionListEl = node.querySelector('.video-version-list');
    const versionCountEl = node.querySelector('.version-count');
    const imageVersionCountEl = node.querySelector('.image-version-count');
    const videoVersionCountEl = node.querySelector('.video-version-count');
    const dialogueEl = node.querySelector('.scene-dialogue');
    const audioVersionListEl = node.querySelector('.audio-version-list');
    const audioVersionCountEl = node.querySelector('.audio-version-count');
    const playbackEl = node.querySelector('.scene-playback');
    const playbackToggleEl = node.querySelector('.scene-playback-toggle');
    const playbackTimelineEl = node.querySelector('.scene-playback-timeline');
    const playbackTimeEl = node.querySelector('.scene-playback-time');
    const playbackAudioEl = node.querySelector('.scene-playback-audio');

    sceneIndexEl.textContent = `Scene ${index + 1}`;
    titleInput.value = scene.title;
    beatEl.value = scene.beat;
    promptEl.value = scene.prompt;
    dialogueEl.value = (scene.lines || []).map((line) => `${line.speaker || 'Narrator'}: ${line.text || ''}`).join('\n');

    const sceneStatus = {
      prompt: Boolean(String(scene.prompt || '').trim()),
      image: (scene.versions || []).some((version) => Boolean(version?.path)),
      dialogue: (scene.lines || []).some((line) => Boolean(String(line?.text || '').trim())),
      audio: (scene.audioVersions || []).some((version) => Boolean(version?.path)),
      video: (scene.videoVersions || []).some((version) => Boolean(version?.path)),
    };
    for (const [type, isPresent] of Object.entries(sceneStatus)) {
      const statusIcon = node.querySelector(`[data-status="${type}"]`);
      const label = `${type[0].toUpperCase()}${type.slice(1)} ${isPresent ? 'ready' : 'missing'}`;
      statusIcon.classList.toggle('is-present', isPresent);
      statusIcon.setAttribute('aria-label', label);
      statusIcon.title = label;
    }

    node.querySelector('.beat-summary').textContent = scene.beat ? scene.beat : 'Add beat, prompt, and dialogue';
    const completeDetailCount = [scene.beat, scene.prompt, scene.lines.length].filter(Boolean).length;
    node.querySelector('.detail-completeness').textContent = `${completeDetailCount}/3`;
    node.querySelector('.scene-details').open = completeDetailCount < 2;

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

    const visualVersionCount = scene.versions.length + scene.videoVersions.length;
    versionCountEl.textContent = `${visualVersionCount} item${visualVersionCount === 1 ? '' : 's'}`;
    imageVersionCountEl.textContent = scene.versions.length;
    videoVersionCountEl.textContent = scene.videoVersions.length;
    imageVersionListEl.innerHTML = '';
    videoVersionListEl.innerHTML = '';
    
    node.querySelector('.visual-history-block').hidden = visualVersionCount === 0;
    node.querySelector('.image-history-group').hidden = scene.versions.length === 0;
    node.querySelector('.video-history-group').hidden = scene.videoVersions.length === 0;
    
    scene.versions.forEach((version, vIndex) => {
      const btn = document.createElement('button');
      btn.className = `version-thumb ${scene.activeVisualType === 'image' && vIndex === scene.activeVersionIndex ? 'active' : ''}`;
      btn.dataset.vindex = vIndex;
      btn.dataset.type = 'image';
      btn.disabled = operation != null;
      const image = document.createElement('img');
      loadProtectedAsset(version.path).then(url => { if (url) image.src = url; });
      image.alt = `Scene version ${vIndex + 1}`;
      const meta = document.createElement('div');
      meta.className = 'version-meta';
      meta.textContent = `v${vIndex + 1}`;
      btn.append(image, meta);
      imageVersionListEl.appendChild(btn);
    });

    scene.videoVersions.forEach((version, vIndex) => {
      const btn = document.createElement('button');
      btn.className = `version-thumb ${scene.activeVisualType === 'video' && vIndex === scene.activeVideoVersionIndex ? 'active' : ''}`;
      btn.dataset.vindex = vIndex;
      btn.dataset.type = 'video';
      btn.disabled = operation != null;
      const video = document.createElement('video');
      loadProtectedAsset(version.path).then(url => { if (url) video.src = url; });
      video.muted = true;
      video.preload = 'metadata';
      video.style.cssText = 'display:block;width:100%;height:72px;object-fit:cover';
      const meta = document.createElement('div');
      meta.className = 'version-meta';
      meta.textContent = `video v${vIndex + 1}`;
      btn.append(video, meta);
      videoVersionListEl.appendChild(btn);
    });

    audioVersionCountEl.textContent = `${scene.audioVersions.length} version${scene.audioVersions.length === 1 ? '' : 's'}`;
    node.querySelector('.audio-version-block').hidden = scene.audioVersions.length === 0;
    audioVersionListEl.innerHTML = '';
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

    scene.audioVersions.forEach((version, vIndex) => {
      const thumb = document.createElement('div');
      thumb.className = `audio-version-thumb ${vIndex === scene.activeAudioVersionIndex ? 'active' : ''}`;
      const meta = document.createElement('div');
      meta.className = 'audio-version-meta';
      const label = document.createElement('strong');
      label.textContent = `Version ${vIndex + 1}`;
      const provider = document.createElement('span');
      provider.textContent = version.provider || 'Audio';
      meta.append(label, provider);
      const audio = document.createElement('audio');
      audio.controls = true;
      loadProtectedAsset(version.path).then(url => { if (url) audio.src = url; });
      audio.addEventListener('play', () => activeScenePlayback?.pause());
      const selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'audio-version-select';
      selectBtn.dataset.vindex = vIndex;
      selectBtn.disabled = operation != null;
      selectBtn.textContent = vIndex === scene.activeAudioVersionIndex ? 'Current' : 'Use this version';
      selectBtn.classList.toggle('is-current', vIndex === scene.activeAudioVersionIndex);
      selectBtn.disabled = operation != null || vIndex === scene.activeAudioVersionIndex;
      thumb.append(meta, audio, selectBtn);
      audioVersionListEl.appendChild(thumb);
    });

    const regenPromptBtn = node.querySelector('.regen-prompt-btn');
    const regenImageBtn = node.querySelector('.regen-image-btn');
    const regenVideoBtn = node.querySelector('.regen-video-btn');
    const regenDialogueBtn = node.querySelector('.regen-dialogue-btn');
    const regenAudioBtn = node.querySelector('.regen-audio-btn');
    
    const busy = operation != null;
    const promptLoading = operation?.type === 'prompts' || (operation?.type === 'prompt' && operation.sceneId === scene.id);
    const imageLoading = ['image', 'imagesSerial'].includes(operation?.type) && operation.sceneId === scene.id;
    const dialogueLoading = operation?.type === 'dialogueAll' || (operation?.type === 'dialogue' && operation.sceneId === scene.id);
    const audioLoading = ['audio', 'audioSerial'].includes(operation?.type) && operation.sceneId === scene.id;
    const videoLoading = ['video', 'videosSerial'].includes(operation?.type) && operation.sceneId === scene.id;
    
    node.classList.toggle('is-busy', promptLoading || imageLoading || dialogueLoading || audioLoading || videoLoading);
    node.querySelector('.prompt-loading').classList.toggle('visible', promptLoading);
    node.querySelector('.image-loading').classList.toggle('visible', imageLoading);
    node.querySelector('.video-loading').classList.toggle('visible', videoLoading);
    
    regenPromptBtn.disabled = busy;
    regenImageBtn.disabled = busy;
    regenVideoBtn.disabled = busy || !scene.versions.length;
    regenDialogueBtn.disabled = busy;
    regenAudioBtn.disabled = busy || !scene.lines.length;
    
    regenImageBtn.textContent = scene.versions.length ? 'Regenerate image' : 'Generate image';
    regenVideoBtn.textContent = scene.videoVersions.length ? 'Regenerate video' : 'Generate video';
    regenAudioBtn.textContent = scene.audioVersions.length ? 'Regenerate audio' : 'Generate audio';
    
    regenVideoBtn.title = scene.versions.length ? '' : 'Generate an image first';
    regenAudioBtn.title = scene.lines.length ? '' : 'Generate dialogue first';
    
    els.storyboardGrid.appendChild(node);
  });
}
