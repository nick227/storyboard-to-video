import { loadProtectedAsset } from '../../core/assets.js';
import { renderCaptionInto } from '../../media/subtitle-overlay.js';

let activeScenePlayback = null;

export function getActiveScenePlayback() {
  return activeScenePlayback;
}

export function pauseActiveScenePlayback() {
  if (activeScenePlayback) {
    activeScenePlayback.pause();
  }
}

export function handleAssetError(error) {
  console.warn('Protected asset load failed:', error);
}

export function setElementProtectedAsset(element, propertyName, path, cacheKeyName = propertyName) {
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

export function bindProtectedAsset(element, path, { signal = null, datasetKey = 'assetPath', extraGuard = null } = {}) {
  if (!element) return;
  if (!path) {
    element.removeAttribute('src');
    return;
  }

  element.dataset[datasetKey] = path;
  
  loadProtectedAsset(path, { signal })
    .then((url) => {
      if (!url) return;
      if (element.dataset[datasetKey] !== path) return;
      if (extraGuard && !extraGuard()) return;
      element.src = url;
    })
    .catch(handleAssetError);
}

export function setupScenePlayback({ toggle, video, audio, hasVideo, hasAudio, words, captionEl, onPlayStart = null }) {
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
    
    if (onPlayStart) onPlayStart();
    
    if (currentTime >= duration) currentTime = 0;
    activeScenePlayback = controller;
    playing = true;
    setToggleState('playing');
    startedAt = performance.now() - currentTime * 1000;
    positionMedia(currentTime, true);
    if (captionEl) renderCaptionInto(captionEl, words, currentTime);
    animationFrame = requestAnimationFrame(tick);
  };
  const togglePlayback = () => { if (playing) pause(); else play(); };
  const controller = {
    pause,
    cleanup() {
      pause();
      toggle.removeEventListener('click', togglePlayback);
      video.removeEventListener('loadedmetadata', updateDuration);
      video.removeEventListener('durationchange', updateDuration);
      audio.removeEventListener('loadedmetadata', updateDuration);
      audio.removeEventListener('durationchange', updateDuration);
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
  toggle.addEventListener('click', togglePlayback);
  updateDuration();
  return controller.cleanup;
}
