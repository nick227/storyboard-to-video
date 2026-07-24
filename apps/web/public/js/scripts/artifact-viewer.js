import { escapeHtml } from './chrome.js';

const STILL_SECONDS = 3;

function formatTime(value) {
  const seconds = Number.isFinite(value) ? Math.max(0, value) : 0;
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function probeDuration(path, kind) {
  if (!path) return Promise.resolve(0);
  return new Promise((resolve) => {
    const el = document.createElement(kind);
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      el.removeAttribute('src');
      el.load();
      resolve(Number.isFinite(value) ? value : 0);
    };
    const timer = setTimeout(() => finish(0), 8000);
    el.preload = 'metadata';
    el.muted = true;
    el.addEventListener('loadedmetadata', () => finish(el.duration), { once: true });
    el.addEventListener('error', () => finish(0), { once: true });
    el.src = path;
  });
}

export function renderStoryboardView(root, scenes = []) {
  if (!scenes.length) {
    root.innerHTML = '<p class="artifact-empty">No storyboard scenes published yet.</p>';
    return;
  }
  root.innerHTML = `<ol class="storyboard-view-grid">${scenes.map((scene, index) => {
    const media = scene.videoPath
      ? `<video src="${escapeHtml(scene.videoPath)}" muted playsinline preload="metadata"></video>`
      : scene.imagePath
        ? `<img src="${escapeHtml(scene.imagePath)}" alt="" loading="lazy" />`
        : '<div class="storyboard-view-missing">No image</div>';
    const narration = scene.narrationText
      ? `<p class="storyboard-view-narration">${escapeHtml(scene.narrationText)}</p>`
      : '';
    return `<li class="storyboard-view-card">
      <div class="storyboard-view-frame">${media}</div>
      <p class="storyboard-view-index">Scene ${index + 1}</p>
      ${narration}
    </li>`;
  }).join('')}</ol>`;
}

export async function renderTimelineView(root, scenes = []) {
  if (!scenes.length) {
    root.innerHTML = '<p class="artifact-empty">No timeline media published yet.</p>';
    return;
  }

  root.innerHTML = `
    <div class="timeline-view-stage">
      <video class="timeline-view-video" muted playsinline preload="auto"></video>
      <img class="timeline-view-image" alt="" hidden />
      <div class="timeline-view-empty" hidden>No preview</div>
      <button type="button" class="timeline-view-toggle" aria-label="Play timeline" disabled>Play</button>
    </div>
    <audio class="timeline-view-audio" preload="auto"></audio>
    <div class="timeline-view-meta">
      <span class="timeline-view-clock">0:00</span>
      <div class="timeline-view-thumbs" role="list"></div>
    </div>`;

  const video = root.querySelector('.timeline-view-video');
  const image = root.querySelector('.timeline-view-image');
  const empty = root.querySelector('.timeline-view-empty');
  const toggle = root.querySelector('.timeline-view-toggle');
  const audio = root.querySelector('.timeline-view-audio');
  const clock = root.querySelector('.timeline-view-clock');
  const thumbs = root.querySelector('.timeline-view-thumbs');

  const segments = [];
  for (let i = 0; i < scenes.length; i += 1) {
    const scene = scenes[i];
    if (!scene.imagePath && !scene.videoPath && !scene.audioPath) continue;
    const [videoDuration, audioDuration] = await Promise.all([
      probeDuration(scene.videoPath, 'video'),
      probeDuration(scene.audioPath, 'audio'),
    ]);
    const duration = Math.max(videoDuration, audioDuration) || STILL_SECONDS;
    segments.push({ ...scene, duration, start: 0 });
  }
  let offset = 0;
  for (const segment of segments) {
    segment.start = offset;
    offset += segment.duration;
  }
  const total = offset;

  thumbs.innerHTML = segments.map((segment, index) => (
    `<button type="button" class="timeline-view-thumb" data-index="${index}" role="listitem" aria-label="${escapeHtml(segment.title || `Scene ${index + 1}`)}">
      ${segment.imagePath ? `<img src="${escapeHtml(segment.imagePath)}" alt="" />` : '<span></span>'}
    </button>`
  )).join('');

  let index = 0;
  let playing = false;
  let raf = 0;
  let stillStartedAt = 0;
  let stillOffset = 0;

  const showSegment = (segment) => {
    if (!segment) {
      video.hidden = true;
      image.hidden = true;
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    if (segment.videoPath) {
      image.hidden = true;
      video.hidden = false;
      if (video.dataset.path !== segment.videoPath) {
        video.dataset.path = segment.videoPath;
        video.src = segment.videoPath;
      }
    } else if (segment.imagePath) {
      video.pause();
      video.hidden = true;
      image.hidden = false;
      image.src = segment.imagePath;
    } else {
      video.hidden = true;
      image.hidden = true;
      empty.hidden = false;
    }
    if (segment.audioPath) {
      if (audio.dataset.path !== segment.audioPath) {
        audio.dataset.path = segment.audioPath;
        audio.src = segment.audioPath;
      }
    } else {
      audio.removeAttribute('src');
      audio.load();
      delete audio.dataset.path;
    }
  };

  const localTime = () => {
    const segment = segments[index];
    if (!segment) return 0;
    if (segment.videoPath && !video.paused) return video.currentTime || 0;
    if (segment.audioPath && !audio.paused) return audio.currentTime || 0;
    if (!playing) return stillOffset;
    return Math.min(segment.duration, stillOffset + (performance.now() - stillStartedAt) / 1000);
  };

  const globalTime = () => (segments[index]?.start || 0) + localTime();

  const tick = () => {
    const segment = segments[index];
    if (!segment) return;
    clock.textContent = formatTime(globalTime());
    if (localTime() >= segment.duration - 0.05) {
      if (index + 1 < segments.length) {
        index += 1;
        stillOffset = 0;
        stillStartedAt = performance.now();
        showSegment(segments[index]);
        startMedia();
      } else {
        stop();
        return;
      }
    }
    raf = requestAnimationFrame(tick);
  };

  const startMedia = () => {
    const segment = segments[index];
    if (!segment) return;
    const tasks = [];
    if (segment.videoPath) {
      video.currentTime = stillOffset;
      tasks.push(video.play().catch(() => {}));
    }
    if (segment.audioPath) {
      audio.currentTime = stillOffset;
      tasks.push(audio.play().catch(() => {}));
    }
    stillStartedAt = performance.now();
  };

  const stop = () => {
    playing = false;
    cancelAnimationFrame(raf);
    video.pause();
    audio.pause();
    stillOffset = localTime();
    toggle.textContent = index >= segments.length - 1 && stillOffset >= (segments[index]?.duration || 0) - 0.05
      ? 'Replay'
      : 'Play';
    clock.textContent = formatTime(globalTime());
  };

  const play = () => {
    if (!segments.length) return;
    if (index >= segments.length - 1 && localTime() >= (segments[index]?.duration || 0) - 0.05) {
      index = 0;
      stillOffset = 0;
    }
    playing = true;
    toggle.textContent = 'Pause';
    showSegment(segments[index]);
    startMedia();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  };

  toggle.disabled = !segments.length;
  toggle.addEventListener('click', () => {
    if (playing) stop();
    else play();
  });

  thumbs.addEventListener('click', (event) => {
    const button = event.target.closest('[data-index]');
    if (!button) return;
    index = Number(button.dataset.index) || 0;
    stillOffset = 0;
    showSegment(segments[index]);
    clock.textContent = formatTime(segments[index]?.start || 0);
    if (playing) {
      startMedia();
    } else {
      toggle.textContent = 'Play';
    }
  });

  showSegment(segments[0]);
  clock.textContent = formatTime(0);
  toggle.textContent = 'Play';
  void total;
}
