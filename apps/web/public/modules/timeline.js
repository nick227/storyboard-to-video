import { sceneStore, uiStore, debounce } from './store.js';

const TIMELINE_PX_PER_SECOND = 60;
const TIMELINE_DEFAULT_STILL_SECONDS = 3;
const TIMELINE_WAVEFORM_SAMPLES_PER_SECOND = 20;

const mediaDurationCache = new Map();
const waveformPeaksCache = new Map();
let timelineController = null;
let timelineBuildToken = 0;
let lastTimelineSignature = null;
let sharedAudioContext = null;
// Kept at module scope (not inside setupTimelinePlayback) so the user's volume/mute choice
// survives a rebuild — the controller is torn down and recreated on every scene edit.
let timelineVolume = 1;
let timelineMuted = false;

let els = {};

export function initTimeline(domEls) {
  els = domEls;
  // Listen to store updates
  sceneStore.subscribe(() => {
    renderTimeline().catch(() => {});
  });
}

export function formatPlaybackTime(value) {
  const seconds = Number.isFinite(value) ? Math.max(0, value) : 0;
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function probeMediaDuration(path, kind) {
  if (!path) return Promise.resolve(0);
  const cacheKey = `${kind}:${path}`;
  if (mediaDurationCache.has(cacheKey)) return Promise.resolve(mediaDurationCache.get(cacheKey));
  return new Promise((resolve) => {
    const element = document.createElement(kind);
    element.preload = 'metadata';
    element.muted = true;
    const finish = (value) => {
      element.removeAttribute('src');
      mediaDurationCache.set(cacheKey, value);
      resolve(value);
    };
    element.addEventListener('loadedmetadata', () => finish(Number.isFinite(element.duration) ? element.duration : 0));
    element.addEventListener('error', () => finish(0));
    element.src = path;
  });
}

function getSharedAudioContext() {
  if (!sharedAudioContext) sharedAudioContext = new (window.AudioContext || window.webkitAudioContext)();
  return sharedAudioContext;
}

async function getWaveformPeaks(audioPath, sampleCount) {
  if (!audioPath) return null;
  if (waveformPeaksCache.has(audioPath)) return waveformPeaksCache.get(audioPath);
  try {
    const response = await fetch(audioPath);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await getSharedAudioContext().decodeAudioData(arrayBuffer);
    const channelData = audioBuffer.getChannelData(0);
    const blockSize = Math.max(1, Math.floor(channelData.length / sampleCount));
    const peaks = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      const start = i * blockSize;
      let max = 0;
      for (let j = 0; j < blockSize && start + j < channelData.length; j++) {
        max = Math.max(max, Math.abs(channelData[start + j]));
      }
      peaks[i] = max;
    }
    waveformPeaksCache.set(audioPath, peaks);
    return peaks;
  } catch (_) {
    return null;
  }
}

function timelineSceneSignature(scene) {
  const activeVersion = scene.versions[scene.activeVersionIndex];
  const activeVideoVersion = scene.videoVersions[scene.activeVideoVersionIndex];
  const activeAudioVersion = scene.audioVersions[scene.activeAudioVersionIndex];
  const hasVideo = scene.activeVisualType === 'video' && Boolean(activeVideoVersion?.path);
  return `${scene.id}:${activeVersion?.path || ''}:${hasVideo ? activeVideoVersion.path : ''}:${activeAudioVersion?.path || ''}`;
}

async function buildTimelineSegments() {
  const rawSegments = sceneStore.get().scenes.map((scene, index) => {
    const activeVersion = scene.versions[scene.activeVersionIndex];
    const activeVideoVersion = scene.videoVersions[scene.activeVideoVersionIndex];
    const activeAudioVersion = scene.audioVersions[scene.activeAudioVersionIndex];
    const hasVideo = scene.activeVisualType === 'video' && Boolean(activeVideoVersion?.path);
    return {
      sceneId: scene.id,
      index,
      title: scene.title || `Scene ${index + 1}`,
      imagePath: activeVersion?.path || null,
      videoPath: hasVideo ? activeVideoVersion.path : null,
      audioPath: activeAudioVersion?.path || null,
    };
  }).filter((segment) => segment.imagePath || segment.videoPath || segment.audioPath);

  const segments = await Promise.all(rawSegments.map(async (segment) => {
    const [videoDuration, audioDuration] = await Promise.all([
      probeMediaDuration(segment.videoPath, 'video'),
      probeMediaDuration(segment.audioPath, 'audio'),
    ]);
    const duration = Math.max(videoDuration, audioDuration) || TIMELINE_DEFAULT_STILL_SECONDS;
    return { ...segment, videoDuration, audioDuration, duration };
  }));

  let offset = 0;
  segments.forEach((segment) => {
    segment.start = offset;
    offset += segment.duration;
  });
  return segments;
}

function setupTimelinePlayback(segments, totalDuration, trackWidth) {
  const { timelineVideo, timelineVideoB, timelineAudio, timelineAudioB, timelineImage: image, timelineStageEmpty: emptyEl,
    timelineToggle: toggle, timelineTime: timeLabel, timelinePlayhead: playhead,
    timelineTrackWrap: trackWrap, timelineTrackInner: trackInner,
    timelineMute: muteBtn, timelineVolumeSlider: volumeSlider } = els;

  // Two video/audio elements, ping-ponged: while segment N plays on the "active" slot, the next
  // segment's media is silently preloaded into the "standby" slot ahead of time. Transitioning
  // is then just pause(old)+play(new) back to back with no fresh network/decode wait in between
  // — that wait (abort -> emptied -> load -> ready, easily 100ms+ off a cold cache) was showing
  // up as an audible gap and a stalled playhead between every clip.
  const videoEls = [timelineVideo, timelineVideoB];
  const audioEls = [timelineAudio, timelineAudioB];
  let activeSlot = 0;
  const activeVideo = () => videoEls[activeSlot];
  const activeAudio = () => audioEls[activeSlot];
  const standbyVideo = () => videoEls[1 - activeSlot];
  const standbyAudio = () => audioEls[1 - activeSlot];

  // Video never carries the composite's sound (it's always element-muted; the audio elements are
  // the sole audio source), so volume/mute only ever needs to apply to the two audio elements.
  audioEls.forEach((el) => { el.volume = timelineVolume; el.muted = timelineMuted; });
  volumeSlider.value = String(timelineVolume);
  const updateMuteButton = () => {
    muteBtn.textContent = timelineMuted || timelineVolume === 0 ? 'Unmute' : 'Mute';
    muteBtn.setAttribute('aria-pressed', String(timelineMuted));
  };
  updateMuteButton();

  // Playback position is tracked from the real audio/video element's currentTime rather than
  // wall-clock elapsed time. Driving the clock off performance.now() let it outrun the actual
  // media whenever play() took a moment to start or buffering stalled it, so segments swapped
  // (killing the previous segment's audio mid-word) before the audio had actually finished.
  let playing = false;
  let currentSegmentIndex = 0;
  let globalCurrentTime = 0;
  let animationFrame = null;
  let stillClockAt = 0;
  let stillClockOffset = 0;
  let segmentEnteredAt = 0;
  let dragging = false;
  let preloadedIndex = -1; // which segment index is currently warmed up in the standby slot

  const localTimeForSegment = (segment) => {
    if (segment.audioPath) return activeAudio().currentTime;
    if (segment.videoPath) return activeVideo().currentTime;
    return stillClockOffset + (performance.now() - stillClockAt) / 1000;
  };

  const updateDisplay = () => {
    timeLabel.textContent = `${formatPlaybackTime(globalCurrentTime)} / ${formatPlaybackTime(totalDuration)}`;
    playhead.style.transform = `translateX(${(globalCurrentTime / totalDuration) * trackWidth}px)`;
  };

  const segmentForTime = (time) => {
    const index = segments.findIndex((segment) => time < segment.start + segment.duration);
    return index === -1 ? segments.length - 1 : index;
  };

  // Loads a segment's media into a specific video/audio element pair without touching visibility
  // — used both to prep the active slot and to silently warm the standby slot ahead of time.
  const applySourceToSlot = (segment, slotVideo, slotAudio) => {
    if (segment.videoPath) {
      slotVideo.loop = Boolean(segment.audioPath && segment.audioDuration > segment.videoDuration);
      if (slotVideo.getAttribute('src') !== segment.videoPath) slotVideo.src = segment.videoPath;
    } else {
      // A hidden video must be fully stopped, not just detached — otherwise a video that was
      // looping (see video.loop above) keeps decoding and looping its old resource in the
      // background for every subsequent segment, wasting decode resources for the rest of
      // playback and competing with whatever audio is trying to play.
      slotVideo.pause();
      slotVideo.loop = false;
      slotVideo.removeAttribute('src');
    }
    if (segment.audioPath) {
      if (slotAudio.getAttribute('src') !== segment.audioPath) slotAudio.src = segment.audioPath;
    } else {
      slotAudio.pause();
      slotAudio.removeAttribute('src');
    }
  };

  // Shows/hides the two video elements and the still image for whichever segment is now active.
  // The standby video always stays hidden while it preloads in the background.
  const applyActiveVisibility = (segment) => {
    videoEls.forEach((el, i) => { el.style.display = (i === activeSlot && segment.videoPath) ? 'block' : 'none'; });
    if (segment.videoPath) {
      image.style.display = 'none';
      image.removeAttribute('src');
    } else if (segment.imagePath) {
      image.src = segment.imagePath;
      image.style.display = 'block';
    } else {
      image.removeAttribute('src');
      image.style.display = 'none';
    }
    emptyEl.style.display = (segment.videoPath || segment.imagePath) ? 'none' : 'flex';
  };

  // Silently warms the standby slot with whatever comes after `afterIndex`, well ahead of when
  // it'll actually be needed (called as soon as a segment becomes active, giving its full
  // duration for the next one to buffer). Safe to call repeatedly.
  const preloadNext = (afterIndex) => {
    const nextIndex = afterIndex + 1;
    if (nextIndex >= segments.length || preloadedIndex === nextIndex) return;
    preloadedIndex = nextIndex;
    applySourceToSlot(segments[nextIndex], standbyVideo(), standbyAudio());
  };

  // Fast path for normal forward playback: if the next segment was already preloaded into the
  // standby slot, this just flips which slot is active and plays it — no fresh load, no gap.
  // Falls back to loading directly into the active slot the same way as before if it wasn't
  // preloaded (e.g. the very first segment).
  const enterSegment = (index, shouldPlay) => {
    const segment = segments[index];
    if (preloadedIndex === index) {
      const outgoingVideo = activeVideo();
      const outgoingAudio = activeAudio();
      activeSlot = 1 - activeSlot;
      outgoingVideo.pause();
      outgoingAudio.pause();
    } else {
      applySourceToSlot(segment, activeVideo(), activeAudio());
    }
    currentSegmentIndex = index;
    applyActiveVisibility(segment);
    stillClockOffset = 0;
    stillClockAt = performance.now();
    segmentEnteredAt = performance.now();
    if (shouldPlay) {
      if (segment.videoPath) activeVideo().play().catch(() => {});
      if (segment.audioPath) activeAudio().play().catch(() => {});
    }
    preloadNext(index);
  };

  const waitUntilReady = (el) => (el.readyState >= 1 ? Promise.resolve() : new Promise((resolve) => {
    const done = () => { el.removeEventListener('loadedmetadata', done); el.removeEventListener('error', done); resolve(); };
    el.addEventListener('loadedmetadata', done);
    el.addEventListener('error', done);
  }));

  // Used for scrubbing / resuming mid-segment: always targets the active slot directly (a jump
  // can land anywhere, so any standby preload is irrelevant) and waits for real readiness before
  // seeking, since we need an exact currentTime, not just "start from the top".
  const seekWithinSegment = async (index, localTime, shouldPlay) => {
    currentSegmentIndex = index;
    const segment = segments[index];
    applySourceToSlot(segment, activeVideo(), activeAudio());
    applyActiveVisibility(segment);
    segmentEnteredAt = performance.now();
    preloadedIndex = -1; // standby preload state is now stale relative to this jump

    const positionEl = async (el, path, duration) => {
      if (!path) { el.pause(); return; }
      await waitUntilReady(el);
      if (currentSegmentIndex !== index) return; // superseded by a newer seek/segment change
      el.currentTime = Math.min(Math.max(localTime, 0), duration || localTime);
      if (shouldPlay) el.play().catch(() => {});
      else el.pause();
    };

    await Promise.all([
      positionEl(activeVideo(), segment.videoPath, segment.videoDuration),
      positionEl(activeAudio(), segment.audioPath, segment.audioDuration),
    ]);
    if (currentSegmentIndex !== index) return;
    if (!segment.audioPath && !segment.videoPath) {
      stillClockOffset = localTime;
      stillClockAt = performance.now();
    }
    preloadNext(index);
  };

  const seekTo = (target, shouldPlay) => {
    globalCurrentTime = Math.min(Math.max(target, 0), totalDuration);
    const index = segmentForTime(globalCurrentTime);
    const segment = segments[index];
    seekWithinSegment(index, globalCurrentTime - segment.start, shouldPlay).catch(() => {});
    updateDisplay();
  };

  const pause = () => {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = null;
    playing = false;
    videoEls.forEach((el) => el.pause());
    audioEls.forEach((el) => el.pause());
    toggle.textContent = globalCurrentTime >= totalDuration ? 'Replay' : 'Play';
    toggle.setAttribute('aria-label', toggle.textContent === 'Replay' ? 'Replay combined timeline' : 'Play combined timeline');
    document.querySelectorAll('.scene-audio, .audio-version-thumb audio').forEach((el) => {
      if (!el.paused) el.pause();
    });
  };

  const tick = () => {
    const segment = segments[currentSegmentIndex];
    const localTime = localTimeForSegment(segment);
    const isLast = currentSegmentIndex === segments.length - 1;
    // Real media time drives advancement; a generous wall-clock overrun is only a safety valve
    // for a stalled/broken media element so the timeline can't hang forever on one segment.
    const wallOverrun = (performance.now() - segmentEnteredAt) / 1000 > segment.duration + 1.5;
    if (localTime >= segment.duration - 0.03 || wallOverrun) {
      if (isLast) {
        seekTo(totalDuration, false);
        pause();
        return;
      }
      enterSegment(currentSegmentIndex + 1, true);
      globalCurrentTime = segments[currentSegmentIndex].start;
    } else {
      globalCurrentTime = Math.min(segment.start + localTime, totalDuration);
    }
    updateDisplay();
    animationFrame = requestAnimationFrame(tick);
  };

  const play = () => {
    if (!totalDuration || dragging) return;

    document.querySelectorAll('.scene-audio, .audio-version-thumb audio, .scene-video').forEach((el) => {
      if (!el.paused && typeof el.pause === 'function') el.pause();
    });

    if (globalCurrentTime >= totalDuration) globalCurrentTime = 0;

    playing = true;
    toggle.textContent = 'Pause';
    toggle.setAttribute('aria-label', 'Pause combined timeline');
    const index = segmentForTime(globalCurrentTime);
    seekWithinSegment(index, globalCurrentTime - segments[index].start, true).catch(() => {});
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = requestAnimationFrame(tick);
  };

  const onToggleClick = () => { if (playing) pause(); else play(); };

  const onMuteClick = () => {
    timelineMuted = !timelineMuted;
    audioEls.forEach((el) => { el.muted = timelineMuted; });
    updateMuteButton();
  };
  const onVolumeInput = () => {
    timelineVolume = Number(volumeSlider.value) || 0;
    audioEls.forEach((el) => { el.volume = timelineVolume; });
    if (timelineMuted && timelineVolume > 0) {
      timelineMuted = false;
      audioEls.forEach((el) => { el.muted = false; });
    }
    updateMuteButton();
  };

  const timeForClientX = (clientX) => {
    const rect = trackInner.getBoundingClientRect();
    const ratio = trackWidth ? Math.min(Math.max((clientX - rect.left) / trackWidth, 0), 1) : 0;
    return ratio * totalDuration;
  };

  let resumeAfterDrag = false;
  const onTrackPointerDown = (event) => {
    dragging = true;
    resumeAfterDrag = playing;
    if (playing) pause();
    trackWrap.setPointerCapture(event.pointerId);
    seekTo(timeForClientX(event.clientX), false);
  };
  const onTrackPointerMove = (event) => {
    if (!dragging) return;
    seekTo(timeForClientX(event.clientX), false);
  };
  const endDrag = (event) => {
    if (!dragging) return;
    dragging = false;
    if (trackWrap.hasPointerCapture(event.pointerId)) trackWrap.releasePointerCapture(event.pointerId);
    if (resumeAfterDrag) play();
  };

  const controller = {
    pause,
    cleanup() {
      pause();
      videoEls.forEach((el) => el.removeAttribute('src'));
      audioEls.forEach((el) => el.removeAttribute('src'));
      image.removeAttribute('src');
      toggle.removeEventListener('click', onToggleClick);
      trackWrap.removeEventListener('pointerdown', onTrackPointerDown);
      trackWrap.removeEventListener('pointermove', onTrackPointerMove);
      trackWrap.removeEventListener('pointerup', endDrag);
      trackWrap.removeEventListener('pointercancel', endDrag);
      muteBtn.removeEventListener('click', onMuteClick);
      volumeSlider.removeEventListener('input', onVolumeInput);
    },
  };

  toggle.disabled = false;
  muteBtn.disabled = false;
  volumeSlider.disabled = false;
  toggle.addEventListener('click', onToggleClick);
  trackWrap.addEventListener('pointerdown', onTrackPointerDown);
  trackWrap.addEventListener('pointermove', onTrackPointerMove);
  trackWrap.addEventListener('pointerup', endDrag);
  trackWrap.addEventListener('pointercancel', endDrag);
  muteBtn.addEventListener('click', onMuteClick);
  volumeSlider.addEventListener('input', onVolumeInput);

  enterSegment(0, false);
  updateDisplay();
  return controller;
}

export async function renderTimeline() {
  const signature = sceneStore.get().scenes.map(timelineSceneSignature).join('|');
  if (signature === lastTimelineSignature) return;
  lastTimelineSignature = signature;

  const buildToken = ++timelineBuildToken;
  const segments = await buildTimelineSegments();
  if (buildToken !== timelineBuildToken) return;

  const hasContent = segments.length > 0;
  els.timelineSection.hidden = !hasContent;
  if (!hasContent) {
    if (timelineController) { timelineController.cleanup(); timelineController = null; }
    return;
  }

  const totalDuration = segments[segments.length - 1].start + segments[segments.length - 1].duration;
  const trackWidth = Math.max(els.timelineTrackWrap.clientWidth - 20, Math.round(totalDuration * TIMELINE_PX_PER_SECOND));
  els.timelineTrackInner.style.width = `${trackWidth}px`;

  els.timelineThumbs.innerHTML = '';
  segments.forEach((segment) => {
    const thumb = document.createElement('div');
    thumb.className = 'timeline-thumb';
    thumb.style.width = `${(segment.duration / totalDuration) * trackWidth}px`;
    thumb.title = segment.title;
    if (segment.videoPath) {
      const video = document.createElement('video');
      video.src = segment.videoPath;
      if (segment.imagePath) video.poster = segment.imagePath;
      video.muted = true;
      video.preload = 'metadata';
      thumb.appendChild(video);
    } else if (segment.imagePath) {
      const img = document.createElement('img');
      img.src = segment.imagePath;
      img.alt = segment.title;
      thumb.appendChild(img);
    } else {
      thumb.classList.add('timeline-thumb-empty');
    }
    const label = document.createElement('span');
    label.className = 'timeline-thumb-label';
    label.textContent = String(segment.index + 1);
    thumb.appendChild(label);
    els.timelineThumbs.appendChild(thumb);
  });

  const canvas = els.timelineWaveformCanvas;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = trackWidth * dpr;
  canvas.height = 48 * dpr;
  canvas.style.width = `${trackWidth}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, trackWidth, 48);
  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  ctx.fillRect(0, 0, trackWidth, 48);

  await Promise.all(segments.map(async (segment) => {
    if (!segment.audioPath) return;
    const segmentWidth = (segment.duration / totalDuration) * trackWidth;
    const segmentX = (segment.start / totalDuration) * trackWidth;
    const sampleCount = Math.max(20, Math.round(segment.duration * TIMELINE_WAVEFORM_SAMPLES_PER_SECOND));
    const peaks = await getWaveformPeaks(segment.audioPath, sampleCount);
    if (buildToken !== timelineBuildToken || !peaks) return;
    const barWidth = segmentWidth / peaks.length;
    ctx.fillStyle = 'rgba(79, 140, 255, 0.85)';
    peaks.forEach((peak, i) => {
      const barHeight = Math.max(1, peak * 44);
      ctx.fillRect(segmentX + i * barWidth, (48 - barHeight) / 2, Math.max(1, barWidth - 1), barHeight);
    });
  }));
  if (buildToken !== timelineBuildToken) return;

  ctx.strokeStyle = 'rgba(48,54,61,0.9)';
  segments.forEach((segment) => {
    if (segment.start === 0) return;
    const x = (segment.start / totalDuration) * trackWidth;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 48);
    ctx.stroke();
  });

  if (timelineController) timelineController.cleanup();
  timelineController = setupTimelinePlayback(segments, totalDuration, trackWidth);
}
