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
  const { timelineVideo: video, timelineAudio: audio, timelineImage: image, timelineStageEmpty: emptyEl,
    timelineToggle: toggle, timelineTime: timeLabel, timelinePlayhead: playhead,
    timelineTrackWrap: trackWrap, timelineTrackInner: trackInner } = els;

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

  const localTimeForSegment = (segment) => {
    if (segment.audioPath) return audio.currentTime;
    if (segment.videoPath) return video.currentTime;
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

  const applyVisualSource = (segment) => {
    if (segment.videoPath) {
      video.loop = Boolean(segment.audioPath && segment.audioDuration > segment.videoDuration);
      if (video.getAttribute('src') !== segment.videoPath) video.src = segment.videoPath;
      video.style.display = 'block';
      image.style.display = 'none';
      image.removeAttribute('src');
    } else {
      video.removeAttribute('src');
      video.style.display = 'none';
      if (segment.imagePath) {
        image.src = segment.imagePath;
        image.style.display = 'block';
      } else {
        image.removeAttribute('src');
        image.style.display = 'none';
      }
    }
    if (segment.audioPath) {
      if (audio.getAttribute('src') !== segment.audioPath) audio.src = segment.audioPath;
    } else {
      audio.removeAttribute('src');
    }
    emptyEl.style.display = (segment.videoPath || segment.imagePath) ? 'none' : 'flex';
  };

  // Fast path for normal forward playback: always starts at local time 0, so there's nothing to
  // wait for or seek — just swap sources and let them play from the top.
  const enterSegment = (index, shouldPlay) => {
    currentSegmentIndex = index;
    const segment = segments[index];
    applyVisualSource(segment);
    stillClockOffset = 0;
    stillClockAt = performance.now();
    segmentEnteredAt = performance.now();
    if (shouldPlay) {
      if (segment.videoPath) video.play().catch(() => {});
      if (segment.audioPath) audio.play().catch(() => {});
    }
  };

  const waitUntilReady = (el) => (el.readyState >= 1 ? Promise.resolve() : new Promise((resolve) => {
    const done = () => { el.removeEventListener('loadedmetadata', done); el.removeEventListener('error', done); resolve(); };
    el.addEventListener('loadedmetadata', done);
    el.addEventListener('error', done);
  }));

  // Used for scrubbing / resuming mid-segment, where we need an accurate seek before playing.
  const seekWithinSegment = async (index, localTime, shouldPlay) => {
    currentSegmentIndex = index;
    const segment = segments[index];
    applyVisualSource(segment);
    segmentEnteredAt = performance.now();

    const positionEl = async (el, path, duration) => {
      if (!path) { el.pause(); return; }
      await waitUntilReady(el);
      if (currentSegmentIndex !== index) return; // superseded by a newer seek/segment change
      el.currentTime = Math.min(Math.max(localTime, 0), duration || localTime);
      if (shouldPlay) el.play().catch(() => {});
      else el.pause();
    };

    await Promise.all([
      positionEl(video, segment.videoPath, segment.videoDuration),
      positionEl(audio, segment.audioPath, segment.audioDuration),
    ]);
    if (currentSegmentIndex !== index) return;
    if (!segment.audioPath && !segment.videoPath) {
      stillClockOffset = localTime;
      stillClockAt = performance.now();
    }
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
    video.pause();
    audio.pause();
    toggle.textContent = globalCurrentTime >= totalDuration ? 'Replay' : 'Play';
    toggle.setAttribute('aria-label', toggle.textContent === 'Replay' ? 'Replay combined timeline' : 'Play combined timeline');
    document.querySelectorAll('.scene-playback-audio, .audio-version-thumb audio').forEach((el) => {
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

    document.querySelectorAll('.scene-playback-audio, .audio-version-thumb audio, .scene-video').forEach((el) => {
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
      video.removeAttribute('src');
      audio.removeAttribute('src');
      image.removeAttribute('src');
      toggle.removeEventListener('click', onToggleClick);
      trackWrap.removeEventListener('pointerdown', onTrackPointerDown);
      trackWrap.removeEventListener('pointermove', onTrackPointerMove);
      trackWrap.removeEventListener('pointerup', endDrag);
      trackWrap.removeEventListener('pointercancel', endDrag);
    },
  };

  toggle.disabled = false;
  toggle.addEventListener('click', onToggleClick);
  trackWrap.addEventListener('pointerdown', onTrackPointerDown);
  trackWrap.addEventListener('pointermove', onTrackPointerMove);
  trackWrap.addEventListener('pointerup', endDrag);
  trackWrap.addEventListener('pointercancel', endDrag);

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
