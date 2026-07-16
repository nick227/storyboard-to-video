const AUDIO_PROVIDERS_CLIENT = ['elevenlabs', 'piper', 'stub'];
const NO_MAPPING_AUDIO_PROVIDERS = ['stub', 'piper'];

const state = {
  styles: [],
  scenes: [],
  lastPromptInputs: null,
  storyboardLibrary: { version: 3, currentId: null, storyboards: [] },
  generating: false,
  stopped: false,
  currentSerialIndex: 0,
  serialState: 'idle',
  operation: null,
  styleReferences: { characters: [], world: [] },
  audioProvider: 'stub',
  voiceMap: { elevenlabs: {}, piper: {}, stub: {} },
  availableVoices: { elevenlabs: [] },
  audioGenerating: false,
  audioStopped: false,
  currentAudioSerialIndex: 0,
  audioSerialState: 'idle',
  videoGenerating: false,
  videoStopped: false,
  currentVideoSerialIndex: 0,
  videoSerialState: 'idle',
};

const els = {
  storyboardPicker: document.getElementById('storyboardPicker'),
  newStoryboardBtn: document.getElementById('newStoryboardBtn'),
  scriptText: document.getElementById('scriptText'),
  sceneCount: document.getElementById('sceneCount'),
  styleSelect: document.getElementById('styleSelect'),
  textProvider: document.getElementById('textProvider'),
  imageProvider: document.getElementById('imageProvider'),
  audioProvider: document.getElementById('audioProvider'),
  commonPromptText: document.getElementById('commonPromptText'),
  generatePromptsBtn: document.getElementById('generatePromptsBtn'),
  startSerialBtn: document.getElementById('startSerialBtn'),
  generateDialogueBtn: document.getElementById('generateDialogueBtn'),
  startAudioSerialBtn: document.getElementById('startAudioSerialBtn'),
  startVideoSerialBtn: document.getElementById('startVideoSerialBtn'),
  saveStateBtn: document.getElementById('saveStateBtn'),
  downloadZipBtn: document.getElementById('downloadZipBtn'),
  statusText: document.getElementById('statusText'),
  storyboardGrid: document.getElementById('storyboardGrid'),
  sceneCardTemplate: document.getElementById('sceneCardTemplate'),
  characterRefs: document.getElementById('characterRefs'),
  worldRefs: document.getElementById('worldRefs'),
  characterRefInput: document.getElementById('characterRefInput'),
  worldRefInput: document.getElementById('worldRefInput'),
  voicesPanel: document.getElementById('voicesPanel'),
};

const STORYBOARD_LIBRARY_KEY = 'storyboard-poc-storyboards';
const LEGACY_STORYBOARD_KEYS = ['storyboard-poc-current', 'storyboard-poc-draft'];

function setStatus(text) {
  els.statusText.textContent = text;
}

function getPayloadBase() {
  return {
    scriptText: els.scriptText.value,
    sceneCount: Number(els.sceneCount.value || 8),
    styleId: els.styleSelect.value,
    commonPromptText: els.commonPromptText.value,
    textProvider: els.textProvider.value,
    imageProvider: els.imageProvider.value,
  };
}

function getPromptInputs() {
  return {
    scriptText: els.scriptText.value,
    commonPromptText: els.commonPromptText.value,
  };
}

function promptInputsMatch(left, right) {
  return Boolean(left && right)
    && left.scriptText === right.scriptText
    && left.commonPromptText === right.commonPromptText;
}

function canGeneratePrompts() {
  return !state.scenes.length || !promptInputsMatch(state.lastPromptInputs, getPromptInputs());
}

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { ...options, headers });
  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_) {
    throw new Error(`Request failed with status ${res.status}`);
  }
  if (!res.ok) {
    const detail = data.error && typeof data.error === 'object' ? data.error : null;
    const error = new Error(detail?.message || data.error || `Request failed with status ${res.status}`);
    error.code = detail?.code || 'REQUEST_FAILED';
    error.retryable = detail?.retryable === true;
    error.status = res.status;
    throw error;
  }
  return data;
}

function parseStoredObject(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch (_) {
    return null;
  }
}

function createStoryboardRecord(storyboard = {}, title = 'Untitled storyboard') {
  return {
    ...storyboard,
    id: typeof storyboard.id === 'string' && storyboard.id ? storyboard.id : crypto.randomUUID(),
    title: String(storyboard.title || title),
    updatedAt: storyboard.updatedAt || new Date().toISOString(),
  };
}

function initializeStoryboardLibrary() {
  const stored = parseStoredObject(localStorage.getItem(STORYBOARD_LIBRARY_KEY));
  if (stored && Array.isArray(stored.storyboards) && stored.storyboards.length) {
    const storyboards = stored.storyboards.map((item) => createStoryboardRecord(item));
    const currentId = storyboards.some((item) => item.id === stored.currentId)
      ? stored.currentId
      : storyboards[0].id;
    state.storyboardLibrary = { version: 3, currentId, storyboards };
    return;
  }

  const legacy = LEGACY_STORYBOARD_KEYS
    .map((key) => parseStoredObject(localStorage.getItem(key)))
    .find(Boolean);
  const first = createStoryboardRecord(legacy || {});
  state.storyboardLibrary = { version: 3, currentId: first.id, storyboards: [first] };
  persistStoryboardLibrary();
}

function persistStoryboardLibrary() {
  localStorage.setItem(STORYBOARD_LIBRARY_KEY, JSON.stringify(state.storyboardLibrary));
}

function getCurrentStoryboardRecord() {
  return state.storyboardLibrary.storyboards.find((item) => item.id === state.storyboardLibrary.currentId) || null;
}

function renderStoryboardPicker() {
  const currentId = state.storyboardLibrary.currentId;
  els.storyboardPicker.replaceChildren();
  state.storyboardLibrary.storyboards
    .slice()
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .forEach((storyboard) => {
      const option = document.createElement('option');
      option.value = storyboard.id;
      option.textContent = storyboard.title;
      els.storyboardPicker.appendChild(option);
    });
  els.storyboardPicker.value = currentId;
}

async function loadStyles() {
  const data = await api('/api/styles');
  state.styles = data.styles || [];
  els.styleSelect.replaceChildren();
  state.styles.forEach((style) => {
    const option = document.createElement('option');
    option.value = style.id;
    option.textContent = style.name;
    els.styleSelect.appendChild(option);
  });
  const saved = getCurrentStoryboardRecord();
  if (saved?.styleId && state.styles.some((x) => x.id === saved.styleId)) {
    els.styleSelect.value = saved.styleId;
  }
  if (!saved?.commonPromptText) prefillCommonPrompt(els.styleSelect.value);
}

function prefillCommonPrompt(styleId) {
  const style = state.styles.find((item) => item.id === styleId);
  els.commonPromptText.value = style?.promptText || '';
}

function normalizeScene(scene, index) {
  const versions = Array.isArray(scene?.versions)
    ? scene.versions.filter((version) => typeof version?.path === 'string' && version.path.startsWith('/generated/'))
    : [];
  const requestedIndex = Number.isInteger(scene?.activeVersionIndex) ? scene.activeVersionIndex : 0;
  const lines = Array.isArray(scene?.lines)
    ? scene.lines
        .filter((line) => line && typeof line.text === 'string' && line.text.trim())
        .map((line) => ({ speaker: String(line.speaker || 'Narrator'), text: String(line.text) }))
    : [];
  const audioVersions = Array.isArray(scene?.audioVersions)
    ? scene.audioVersions.filter((version) => typeof version?.path === 'string' && version.path.startsWith('/audio/'))
    : [];
  const requestedAudioIndex = Number.isInteger(scene?.activeAudioVersionIndex) ? scene.activeAudioVersionIndex : 0;
  const videoVersions = Array.isArray(scene?.videoVersions)
    ? scene.videoVersions.filter((version) => typeof version?.path === 'string' && version.path.startsWith('/videos/'))
    : [];
  const requestedVideoIndex = Number.isInteger(scene?.activeVideoVersionIndex) ? scene.activeVideoVersionIndex : videoVersions.length - 1;
  let activeVisualType = scene?.activeVisualType === 'image' || scene?.activeVisualType === 'video'
    ? scene.activeVisualType
    : (videoVersions.length ? 'video' : 'image');
  if (activeVisualType === 'video' && !videoVersions.length) activeVisualType = 'image';
  if (activeVisualType === 'image' && !versions.length && videoVersions.length) activeVisualType = 'video';
  return {
    id: typeof scene?.id === 'string' ? scene.id : crypto.randomUUID(),
    title: String(scene?.title || `Scene ${index + 1}`),
    beat: String(scene?.beat || ''),
    prompt: String(scene?.prompt || ''),
    versions,
    activeVersionIndex: versions.length ? Math.min(Math.max(requestedIndex, 0), versions.length - 1) : 0,
    lines,
    audioVersions,
    activeAudioVersionIndex: audioVersions.length ? Math.min(Math.max(requestedAudioIndex, 0), audioVersions.length - 1) : 0,
    videoVersions,
    activeVideoVersionIndex: videoVersions.length ? Math.min(Math.max(requestedVideoIndex, 0), videoVersions.length - 1) : 0,
    activeVisualType,
  };
}

function formatDialogueLines(lines) {
  return (lines || []).map((line) => `${line.speaker || 'Narrator'}: ${line.text || ''}`).join('\n');
}

function parseDialogueText(text) {
  return String(text || '')
    .split('\n')
    .map((row) => row.trim())
    .filter(Boolean)
    .map((row) => {
      const colonIndex = row.indexOf(':');
      if (colonIndex === -1) return { speaker: 'Narrator', text: row };
      const speaker = row.slice(0, colonIndex).trim() || 'Narrator';
      const text = row.slice(colonIndex + 1).trim();
      return { speaker, text };
    })
    .filter((line) => line.text);
}

function getSpeakersFromScenes() {
  const speakers = new Set();
  state.scenes.forEach((scene) => scene.lines.forEach((line) => speakers.add(line.speaker || 'Narrator')));
  return speakers.size ? [...speakers] : ['Narrator'];
}

function renderStyleReferenceList(container, items, type) {
  container.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'style-ref-empty';
    empty.textContent = `No ${type} references yet.`;
    container.appendChild(empty);
    return;
  }

  items.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'style-ref-item';
    const image = document.createElement('img');
    image.src = item.url;
    image.alt = item.fileName;
    const meta = document.createElement('div');
    meta.className = 'style-ref-meta';
    const name = document.createElement('div');
    name.className = 'style-ref-name';
    name.textContent = item.fileName;
    const button = document.createElement('button');
    button.textContent = '×';
    button.className = 'ref-delete-btn';
    button.setAttribute('aria-label', `Delete ${item.fileName}`);
    button.title = `Delete ${item.fileName}`;
    button.addEventListener('click', () => deleteStyleReference(type, item.fileName));
    meta.append(name);
    card.append(image, meta, button);
    container.appendChild(card);
  });
}

function renderStyleReferences() {
  renderStyleReferenceList(els.characterRefs, state.styleReferences.characters || [], 'characters');
  renderStyleReferenceList(els.worldRefs, state.styleReferences.world || [], 'world');
}

async function loadStyleReferences(styleId) {
  try {
    const data = await api(`/api/styles/${encodeURIComponent(styleId)}/references`);
    state.styleReferences = data.references || { characters: [], world: [] };
    renderStyleReferences();
  } catch (error) {
    state.styleReferences = { characters: [], world: [] };
    renderStyleReferences();
    setStatus(`Could not load references: ${error.message}`);
  }
}

async function uploadStyleReferences(type, files) {
  if (!files?.length) return;
  try {
    setStatus(`Uploading ${type} references...`);
    const form = new FormData();
    [...files].forEach((file) => form.append('files', file));
    const styleId = els.styleSelect.value;
    const data = await api(`/api/styles/${encodeURIComponent(styleId)}/references/upload?type=${encodeURIComponent(type)}`, {
      method: 'POST',
      body: form,
    });
    state.styleReferences = data.references || { characters: [], world: [] };
    renderStyleReferences();
    setStatus(`${type} references uploaded.`);
  } catch (error) {
    setStatus(`Reference upload failed: ${error.message}`);
  }
}

async function deleteStyleReference(type, fileName) {
  try {
    const styleId = els.styleSelect.value;
    const data = await api(`/api/styles/${encodeURIComponent(styleId)}/references`, {
      method: 'DELETE',
      body: JSON.stringify({ type, fileName }),
    });
    state.styleReferences = data.references || { characters: [], world: [] };
    renderStyleReferences();
    setStatus('Reference deleted.');
  } catch (error) {
    setStatus(`Delete failed: ${error.message}`);
  }
}

async function loadElevenLabsVoices() {
  if (state.availableVoices.elevenlabs.length) return;
  try {
    const data = await api('/api/audio/voices?provider=elevenlabs');
    state.availableVoices.elevenlabs = data.voices || [];
  } catch (error) {
    setStatus(`Could not load ElevenLabs voices: ${error.message}`);
  }
}

function renderVoicesPanel() {
  const speakers = getSpeakersFromScenes();
  const provider = state.audioProvider;
  const voiceMap = state.voiceMap[provider] || (state.voiceMap[provider] = {});
  const availableVoices = provider === 'elevenlabs' ? state.availableVoices.elevenlabs : [];
  els.voicesPanel.innerHTML = '';

  speakers.forEach((speaker) => {
    const row = document.createElement('div');
    row.className = 'voice-row';

    const label = document.createElement('div');
    label.className = 'voice-speaker';
    label.textContent = speaker;
    row.appendChild(label);

    if (NO_MAPPING_AUDIO_PROVIDERS.includes(provider)) {
      const note = document.createElement('span');
      note.className = 'voice-note';
      note.textContent = provider === 'piper'
        ? 'Local neural voice (Piper), auto-assigned per speaker (no mapping needed)'
        : 'Local rudimentary voice, auto-assigned per speaker (no mapping needed)';
      row.appendChild(note);
    } else {
      const select = document.createElement('select');
      select.disabled = isBusy();
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = availableVoices.length ? 'Choose a voice...' : 'No voices loaded';
      select.appendChild(blank);
      availableVoices.forEach((voice) => {
        const option = document.createElement('option');
        option.value = voice.voiceId;
        option.textContent = voice.label || voice.voiceId;
        select.appendChild(option);
      });
      const mapped = voiceMap[speaker];
      select.value = mapped?.voiceId || '';
      row.classList.toggle('voice-unmapped', !mapped?.voiceId);
      select.addEventListener('change', () => {
        const chosen = availableVoices.find((voice) => voice.voiceId === select.value);
        if (chosen) voiceMap[speaker] = { voiceId: chosen.voiceId, label: chosen.label };
        else delete voiceMap[speaker];
        row.classList.toggle('voice-unmapped', !voiceMap[speaker]?.voiceId);
        saveStoryboard(false);
      });
      row.appendChild(select);
    }

    els.voicesPanel.appendChild(row);
  });
}

function isBusy() {
  return Boolean(state.operation) || state.generating;
}

function setLoadingButton(button, loading) {
  button.classList.toggle('is-loading', loading);
  button.setAttribute('aria-busy', String(loading));
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

function renderScenes() {
  if (!state.scenes.length && state.operation?.type === 'prompts') {
    renderEmptyPromptTargets();
    return;
  }
  els.storyboardGrid.innerHTML = '';

  state.scenes.forEach((scene, index) => {
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
    const currentAudioEl = node.querySelector('.current-audio');
    const currentAudioPlayerEl = node.querySelector('.current-audio-player');
    const currentAudioVersionEl = node.querySelector('.current-audio-version');

    sceneIndexEl.textContent = `Scene ${index + 1}`;
    titleInput.value = scene.title;
    beatEl.value = scene.beat;
    promptEl.value = scene.prompt;
    dialogueEl.value = formatDialogueLines(scene.lines);
    node.querySelector('.beat-summary').textContent = scene.beat ? scene.beat : 'Add beat, prompt, and dialogue';
    const completeDetailCount = [scene.beat, scene.prompt, scene.lines.length].filter(Boolean).length;
    node.querySelector('.detail-completeness').textContent = `${completeDetailCount}/3`;
    node.querySelector('.scene-details').open = completeDetailCount < 2;

    titleInput.addEventListener('input', (e) => {
      scene.title = e.target.value;
      saveStoryboard(false);
    });
    beatEl.addEventListener('input', (e) => {
      scene.beat = e.target.value;
      saveStoryboard(false);
    });
    promptEl.addEventListener('input', (e) => {
      scene.prompt = e.target.value;
      saveStoryboard(false);
    });
    dialogueEl.addEventListener('input', (e) => {
      scene.lines = parseDialogueText(e.target.value);
      saveStoryboard(false);
      renderVoicesPanel();
    });

    const activeVersion = scene.versions[scene.activeVersionIndex];
    const activeVideoVersion = scene.videoVersions[scene.activeVideoVersionIndex];
    if (scene.activeVisualType === 'video' && activeVideoVersion?.path) {
      videoEl.src = activeVideoVersion.path;
      videoEl.style.display = 'block';
      imageEl.removeAttribute('src');
      imageEl.style.display = 'none';
      placeholderEl.style.display = 'none';
    } else if (activeVersion?.path) {
      imageEl.src = activeVersion.path;
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
      btn.disabled = isBusy();
      const image = document.createElement('img');
      image.src = version.path;
      image.alt = `Scene version ${vIndex + 1}`;
      const meta = document.createElement('div');
      meta.className = 'version-meta';
      meta.textContent = `v${vIndex + 1}`;
      btn.append(image, meta);
      btn.addEventListener('click', () => {
        scene.activeVersionIndex = vIndex;
        scene.activeVisualType = 'image';
        renderScenes();
        saveStoryboard(false);
      });
      imageVersionListEl.appendChild(btn);
    });
    scene.videoVersions.forEach((version, vIndex) => {
      const btn = document.createElement('button');
      btn.className = `version-thumb ${scene.activeVisualType === 'video' && vIndex === scene.activeVideoVersionIndex ? 'active' : ''}`;
      btn.disabled = isBusy();
      const video = document.createElement('video');
      video.src = version.path;
      video.muted = true;
      video.preload = 'metadata';
      video.style.cssText = 'display:block;width:100%;height:72px;object-fit:cover';
      const meta = document.createElement('div');
      meta.className = 'version-meta';
      meta.textContent = `video v${vIndex + 1}`;
      btn.append(video, meta);
      btn.addEventListener('click', () => {
        scene.activeVideoVersionIndex = vIndex;
        scene.activeVisualType = 'video';
        renderScenes();
        saveStoryboard(false);
      });
      videoVersionListEl.appendChild(btn);
    });

    audioVersionCountEl.textContent = `${scene.audioVersions.length} version${scene.audioVersions.length === 1 ? '' : 's'}`;
    node.querySelector('.audio-version-block').hidden = scene.audioVersions.length === 0;
    audioVersionListEl.innerHTML = '';
    const activeAudioVersion = scene.audioVersions[scene.activeAudioVersionIndex];
    if (activeAudioVersion?.path) {
      currentAudioEl.hidden = false;
      currentAudioPlayerEl.src = activeAudioVersion.path;
      currentAudioVersionEl.textContent = `v${scene.activeAudioVersionIndex + 1}`;
    }
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
      audio.src = version.path;
      const selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'audio-version-select';
      selectBtn.disabled = isBusy();
      selectBtn.textContent = vIndex === scene.activeAudioVersionIndex ? 'Current' : 'Use this version';
      selectBtn.classList.toggle('is-current', vIndex === scene.activeAudioVersionIndex);
      selectBtn.disabled = isBusy() || vIndex === scene.activeAudioVersionIndex;
      selectBtn.addEventListener('click', () => {
        scene.activeAudioVersionIndex = vIndex;
        renderScenes();
        saveStoryboard(false);
      });
      thumb.append(meta, audio, selectBtn);
      audioVersionListEl.appendChild(thumb);
    });

    const regenPromptBtn = node.querySelector('.regen-prompt-btn');
    const regenImageBtn = node.querySelector('.regen-image-btn');
    const regenVideoBtn = node.querySelector('.regen-video-btn');
    const regenDialogueBtn = node.querySelector('.regen-dialogue-btn');
    const regenAudioBtn = node.querySelector('.regen-audio-btn');
    const busy = isBusy();
    const promptLoading = state.operation?.type === 'prompts' || (state.operation?.type === 'prompt' && state.operation.sceneId === scene.id);
    const imageLoading = ['image', 'serial'].includes(state.operation?.type) && state.operation.sceneId === scene.id;
    const dialogueLoading = state.operation?.type === 'dialogueAll' || (state.operation?.type === 'dialogue' && state.operation.sceneId === scene.id);
    const audioLoading = ['audio', 'audioSerial'].includes(state.operation?.type) && state.operation.sceneId === scene.id;
    const videoLoading = ['video', 'videoSerial'].includes(state.operation?.type) && state.operation.sceneId === scene.id;
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
    setLoadingButton(regenPromptBtn, promptLoading && state.operation?.type === 'prompt');
    setLoadingButton(regenImageBtn, imageLoading && state.operation?.type === 'image');
    setLoadingButton(regenVideoBtn, videoLoading && state.operation?.type === 'video');
    setLoadingButton(regenDialogueBtn, dialogueLoading && state.operation?.type === 'dialogue');
    setLoadingButton(regenAudioBtn, audioLoading && state.operation?.type === 'audio');
    regenPromptBtn.addEventListener('click', () => regeneratePrompt(index));
    regenImageBtn.addEventListener('click', () => regenerateImage(index).catch(() => {}));
    regenVideoBtn.addEventListener('click', () => regenerateVideo(index).catch(() => {}));
    regenDialogueBtn.addEventListener('click', () => regenerateDialogue(index));
    regenAudioBtn.addEventListener('click', () => regenerateAudio(index).catch(() => {}));

    els.storyboardGrid.appendChild(node);
  });
}

async function generatePrompts() {
  if (isBusy() || !canGeneratePrompts()) return;
  state.operation = { type: 'prompts' };
  updateButtons();
  renderScenes();
  try {
    setStatus('Generating scene prompts...');
    const base = getPayloadBase();
    const data = await api('/api/storyboard/generate-prompts', {
      method: 'POST',
      body: JSON.stringify({
        scriptText: base.scriptText,
        sceneCount: base.sceneCount,
        styleId: base.styleId,
        commonPromptText: base.commonPromptText,
        provider: base.textProvider,
      }),
    });

    const previousScenes = state.scenes;
    state.scenes = (data.scenes || []).map((nextScene, index) => normalizeScene({
      ...nextScene,
      id: previousScenes[index]?.id,
      versions: previousScenes[index]?.versions || [],
      activeVersionIndex: previousScenes[index]?.activeVersionIndex || 0,
      videoVersions: previousScenes[index]?.videoVersions || [],
      activeVideoVersionIndex: previousScenes[index]?.activeVideoVersionIndex || 0,
      activeVisualType: previousScenes[index]?.activeVisualType,
    }, index));
    state.lastPromptInputs = getPromptInputs();
    saveStoryboard(false);
    state.serialState = 'idle';
    state.currentSerialIndex = 0;
    setStatus(data.usedFallback ? data.warning : `Generated ${state.scenes.length} scene prompts with ${base.textProvider}.`);
  } catch (error) {
    setStatus(`Prompt generation failed: ${error.message}`);
  } finally {
    state.operation = null;
    updateButtons();
    renderScenes();
  }
}

async function regeneratePrompt(index) {
  const scene = state.scenes[index];
  if (!scene || isBusy()) return;
  state.operation = { type: 'prompt', sceneId: scene.id };
  updateButtons();
  renderScenes();
  try {
    setStatus(`Regenerating prompt for scene ${index + 1}...`);
    const base = getPayloadBase();
    const data = await api('/api/storyboard/regenerate-prompt', {
      method: 'POST',
      body: JSON.stringify({
        scriptText: base.scriptText,
        scene,
        sceneIndex: index,
        styleId: base.styleId,
        commonPromptText: base.commonPromptText,
        provider: base.textProvider,
      }),
    });
    scene.prompt = data.prompt || scene.prompt;
    saveStoryboard(false);
    setStatus(data.usedFallback ? data.warning : `Prompt updated for scene ${index + 1}.`);
  } catch (error) {
    setStatus(`Prompt regeneration failed: ${error.message}`);
  } finally {
    state.operation = null;
    updateButtons();
    renderScenes();
  }
}

async function generateDialogue() {
  if (isBusy() || !state.scenes.length) {
    if (!state.scenes.length) setStatus('Generate scene prompts first.');
    return;
  }
  state.operation = { type: 'dialogueAll' };
  updateButtons();
  renderScenes();
  try {
    setStatus('Organizing dialogue by speaker...');
    const base = getPayloadBase();
    const data = await api('/api/storyboard/generate-dialogue', {
      method: 'POST',
      body: JSON.stringify({
        scriptText: base.scriptText,
        scenes: state.scenes.map((scene, index) => ({ sceneNumber: index + 1, title: scene.title, beat: scene.beat, prompt: scene.prompt })),
        provider: base.textProvider,
      }),
    });

    (data.scenesDialogue || []).forEach((sceneDialogue, index) => {
      if (state.scenes[index]) state.scenes[index].lines = sceneDialogue.lines || [];
    });
    saveStoryboard(false);
    renderVoicesPanel();
    setStatus(data.usedFallback ? data.warning : `Organized dialogue for ${state.scenes.length} scenes with ${base.textProvider}.`);
  } catch (error) {
    setStatus(`Dialogue generation failed: ${error.message}`);
  } finally {
    state.operation = null;
    updateButtons();
    renderScenes();
  }
}

async function regenerateDialogue(index) {
  const scene = state.scenes[index];
  if (!scene || isBusy()) return;
  state.operation = { type: 'dialogue', sceneId: scene.id };
  updateButtons();
  renderScenes();
  try {
    setStatus(`Regenerating dialogue for scene ${index + 1}...`);
    const base = getPayloadBase();
    const data = await api('/api/storyboard/regenerate-dialogue', {
      method: 'POST',
      body: JSON.stringify({
        scriptText: base.scriptText,
        scene,
        sceneIndex: index,
        provider: base.textProvider,
        knownSpeakers: getSpeakersFromScenes(),
      }),
    });
    scene.lines = data.lines || scene.lines;
    saveStoryboard(false);
    renderVoicesPanel();
    setStatus(data.usedFallback ? data.warning : `Dialogue updated for scene ${index + 1}.`);
  } catch (error) {
    setStatus(`Dialogue regeneration failed: ${error.message}`);
  } finally {
    state.operation = null;
    updateButtons();
    renderScenes();
  }
}

async function regenerateImage(index, { withinSerial = false } = {}) {
  const scene = state.scenes[index];
  if (!scene || (!withinSerial && isBusy())) return;
  if (!withinSerial) {
    state.operation = { type: 'image', sceneId: scene.id };
    updateButtons();
    renderScenes();
  }
  try {
    setStatus(`Generating image for scene ${index + 1}...`);
    const base = getPayloadBase();
    const data = await api('/api/images/generate', {
      method: 'POST',
      body: JSON.stringify({
        sceneNumber: index + 1,
        sceneTitle: scene.title,
        scenePrompt: scene.prompt,
        styleId: base.styleId,
        commonPromptText: base.commonPromptText,
        provider: base.imageProvider,
      }),
    });

    scene.versions.push({
      path: data.image.path,
      prompt: data.image.prompt,
      createdAt: new Date().toISOString(),
    });
    scene.activeVersionIndex = scene.versions.length - 1;
    scene.activeVisualType = 'image';
    saveStoryboard(false);
    setStatus(`Image ready for scene ${index + 1}. ${data.referenceCount || 0} style refs used.`);
  } catch (error) {
    setStatus(`Image generation failed for scene ${index + 1}: ${error.message}`);
    throw error;
  } finally {
    if (!withinSerial) {
      state.operation = null;
      updateButtons();
      renderScenes();
    }
  }
}

async function startSerial(fromIndex = 0, trigger = 'start') {
  if (!state.scenes.length) {
    setStatus('No scenes to generate.');
    return;
  }
  if (isBusy()) return;
  state.generating = true;
  state.stopped = false;
  state.serialState = 'running';
  state.currentSerialIndex = Math.min(Math.max(fromIndex, 0), state.scenes.length);
  state.operation = { type: 'serial', sceneId: state.scenes[state.currentSerialIndex]?.id || null, trigger };
  updateButtons();
  renderScenes();

  for (let i = state.currentSerialIndex; i < state.scenes.length; i++) {
    if (state.stopped) break;
    state.currentSerialIndex = i;
    const scene = state.scenes[i];
    state.operation = { type: 'serial', sceneId: scene.id, trigger };
    renderScenes();
    if (!scene.prompt?.trim()) {
      state.currentSerialIndex = i + 1;
      continue;
    }
    try {
      await regenerateImage(i, { withinSerial: true });
      state.currentSerialIndex = i + 1;
    } catch (_) {
      state.stopped = true;
      state.serialState = 'failed';
      break;
    }
  }

  if (state.serialState === 'failed') setStatus(`Serial generation failed at scene ${state.currentSerialIndex + 1}. Resume will retry it.`);
  else if (state.stopped) {
    state.serialState = 'paused';
    setStatus(`Serial generation paused before scene ${state.currentSerialIndex + 1}.`);
  } else {
    state.serialState = 'complete';
    setStatus('Serial generation complete.');
  }

  state.generating = false;
  state.operation = null;
  updateButtons();
  renderScenes();
}

function stopSerial() {
  state.stopped = true;
  updateButtons();
  setStatus(`Stopping after Scene ${state.currentSerialIndex + 1} finishes…`);
}

function resumeSerial() {
  if (!['paused', 'failed'].includes(state.serialState)) {
    setStatus('There is no paused or failed serial run to resume.');
    return;
  }
  startSerial(state.currentSerialIndex, 'resume');
}

async function preflightVideoProvider() {
  try {
    await api('/api/videos/preflight');
    return true;
  } catch (error) {
    console.error('Video generation aborted during preflight:', error);
    return false;
  }
}

async function regenerateVideo(index, { withinSerial = false } = {}) {
  const scene = state.scenes[index];
  if (!scene || (!withinSerial && isBusy())) return;
  const sourceImage = scene.versions[scene.activeVersionIndex];
  if (!sourceImage?.path) throw new Error('Scene has no generated reference image.');
  if (!withinSerial && !(await preflightVideoProvider())) return;
  if (!withinSerial) {
    state.operation = { type: 'video', sceneId: scene.id };
    updateButtons();
    renderScenes();
  }
  try {
    setStatus(`Generating video for scene ${index + 1}...`);
    const data = await api('/api/videos/generate', {
      method: 'POST',
      body: JSON.stringify({
        sceneNumber: index + 1,
        sceneTitle: scene.title,
        scenePrompt: scene.prompt,
        imagePath: sourceImage.path,
      }),
    });
    scene.videoVersions.push({
      path: data.video.path,
      prompt: data.video.prompt,
      sourceImagePath: data.video.sourceImagePath,
      provider: data.video.provider,
      createdAt: new Date().toISOString(),
    });
    scene.activeVideoVersionIndex = scene.videoVersions.length - 1;
    scene.activeVisualType = 'video';
    saveStoryboard(false);
    setStatus(`Video ready for scene ${index + 1}.`);
  } catch (error) {
    setStatus(`Video generation failed for scene ${index + 1}: ${error.message}`);
    throw error;
  } finally {
    if (!withinSerial) {
      state.operation = null;
      updateButtons();
      renderScenes();
    }
  }
}

async function startVideoSerial(fromIndex = 0, trigger = 'start') {
  if (isBusy()) return;
  const eligibleScenes = state.scenes.filter((scene) => scene.versions.length);
  if (!eligibleScenes.length) {
    setStatus('No generated reference images are available for video generation.');
    return;
  }
  // This gate intentionally runs before changing operation, serial, status, or scene state.
  if (!(await preflightVideoProvider())) return;

  state.videoGenerating = true;
  state.videoStopped = false;
  state.videoSerialState = 'running';
  state.currentVideoSerialIndex = Math.min(Math.max(fromIndex, 0), state.scenes.length);
  state.operation = { type: 'videoSerial', sceneId: state.scenes[state.currentVideoSerialIndex]?.id || null, trigger };
  updateButtons();
  renderScenes();
  let skipped = 0;

  for (let i = state.currentVideoSerialIndex; i < state.scenes.length; i++) {
    if (state.videoStopped) break;
    state.currentVideoSerialIndex = i;
    const scene = state.scenes[i];
    if (!scene.versions.length) {
      skipped += 1;
      state.currentVideoSerialIndex = i + 1;
      continue;
    }
    state.operation = { type: 'videoSerial', sceneId: scene.id, trigger };
    renderScenes();
    try {
      await regenerateVideo(i, { withinSerial: true });
      state.currentVideoSerialIndex = i + 1;
    } catch (_) {
      state.videoStopped = true;
      state.videoSerialState = 'failed';
      break;
    }
  }

  if (state.videoSerialState === 'failed') setStatus(`Video generation halted at scene ${state.currentVideoSerialIndex + 1}. Resume will retry it.`);
  else if (state.videoStopped) {
    state.videoSerialState = 'paused';
    setStatus(`Video generation paused before scene ${state.currentVideoSerialIndex + 1}.`);
  } else {
    state.videoSerialState = 'complete';
    setStatus(`Video generation complete.${skipped ? ` Skipped ${skipped} scene${skipped === 1 ? '' : 's'} without reference images.` : ''}`);
  }
  state.videoGenerating = false;
  state.operation = null;
  updateButtons();
  renderScenes();
}

function stopVideoSerial() {
  state.videoStopped = true;
  updateButtons();
  setStatus(`Stopping videos after Scene ${state.currentVideoSerialIndex + 1} finishes…`);
}

function resumeVideoSerial() {
  if (!['paused', 'failed'].includes(state.videoSerialState)) {
    setStatus('There is no paused or failed video run to resume.');
    return;
  }
  startVideoSerial(state.currentVideoSerialIndex, 'resume');
}

async function regenerateAudio(index, { withinSerial = false } = {}) {
  const scene = state.scenes[index];
  if (!scene || (!withinSerial && isBusy())) return;
  if (!scene.lines.length) throw new Error('Scene has no dialogue lines. Generate dialogue first.');
  if (!withinSerial) {
    state.operation = { type: 'audio', sceneId: scene.id };
    updateButtons();
    renderScenes();
  }
  try {
    setStatus(`Generating audio for scene ${index + 1}...`);
    const data = await api('/api/audio/generate', {
      method: 'POST',
      body: JSON.stringify({
        sceneNumber: index + 1,
        sceneTitle: scene.title,
        lines: scene.lines,
        provider: state.audioProvider,
        voiceMap: state.voiceMap[state.audioProvider] || {},
      }),
    });

    scene.audioVersions.push({
      path: data.audio.path,
      provider: state.audioProvider,
      createdAt: new Date().toISOString(),
    });
    scene.activeAudioVersionIndex = scene.audioVersions.length - 1;
    saveStoryboard(false);
    setStatus(`Audio ready for scene ${index + 1}.`);
  } catch (error) {
    setStatus(`Audio generation failed for scene ${index + 1}: ${error.message}`);
    throw error;
  } finally {
    if (!withinSerial) {
      state.operation = null;
      updateButtons();
      renderScenes();
    }
  }
}

function getUnmappedSpeakers() {
  if (NO_MAPPING_AUDIO_PROVIDERS.includes(state.audioProvider)) return [];
  const voiceMap = state.voiceMap[state.audioProvider] || {};
  return getSpeakersFromScenes().filter((speaker) => !voiceMap[speaker]?.voiceId);
}

async function startAudioSerial(fromIndex = 0, trigger = 'start') {
  if (!state.scenes.length) {
    setStatus('No scenes to generate audio for.');
    return;
  }
  if (isBusy()) return;
  const unmapped = getUnmappedSpeakers();
  if (unmapped.length) {
    setStatus(`Assign a voice for: ${unmapped.join(', ')} before generating audio.`);
    return;
  }
  state.audioGenerating = true;
  state.audioStopped = false;
  state.audioSerialState = 'running';
  state.currentAudioSerialIndex = Math.min(Math.max(fromIndex, 0), state.scenes.length);
  state.operation = { type: 'audioSerial', sceneId: state.scenes[state.currentAudioSerialIndex]?.id || null, trigger };
  updateButtons();
  renderScenes();

  for (let i = state.currentAudioSerialIndex; i < state.scenes.length; i++) {
    if (state.audioStopped) break;
    state.currentAudioSerialIndex = i;
    const scene = state.scenes[i];
    state.operation = { type: 'audioSerial', sceneId: scene.id, trigger };
    renderScenes();
    if (!scene.lines.length) {
      state.currentAudioSerialIndex = i + 1;
      continue;
    }
    try {
      await regenerateAudio(i, { withinSerial: true });
      state.currentAudioSerialIndex = i + 1;
    } catch (_) {
      state.audioStopped = true;
      state.audioSerialState = 'failed';
      break;
    }
  }

  if (state.audioSerialState === 'failed') setStatus(`Audio generation failed at scene ${state.currentAudioSerialIndex + 1}. Resume will retry it.`);
  else if (state.audioStopped) {
    state.audioSerialState = 'paused';
    setStatus(`Audio generation paused before scene ${state.currentAudioSerialIndex + 1}.`);
  } else {
    state.audioSerialState = 'complete';
    setStatus('Audio generation complete.');
  }

  state.audioGenerating = false;
  state.operation = null;
  updateButtons();
  renderScenes();
}

function stopAudioSerial() {
  state.audioStopped = true;
  updateButtons();
  setStatus(`Stopping audio after Scene ${state.currentAudioSerialIndex + 1} finishes…`);
}

function resumeAudioSerial() {
  if (!['paused', 'failed'].includes(state.audioSerialState)) {
    setStatus('There is no paused or failed audio run to resume.');
    return;
  }
  startAudioSerial(state.currentAudioSerialIndex, 'resume');
}

function getStoryboard() {
  return {
    title: getCurrentStoryboardRecord()?.title || 'Untitled storyboard',
    scriptText: els.scriptText.value,
    sceneCount: els.sceneCount.value,
    styleId: els.styleSelect.value,
    textProvider: els.textProvider.value,
    imageProvider: els.imageProvider.value,
    audioProvider: state.audioProvider,
    voiceMap: state.voiceMap,
    commonPromptText: els.commonPromptText.value,
    lastPromptInputs: state.lastPromptInputs,
    scenes: state.scenes,
  };
}

function saveStoryboard(showStatus = true) {
  try {
    const current = getCurrentStoryboardRecord();
    if (!current) return;
    Object.assign(current, getStoryboard(), { updatedAt: new Date().toISOString() });
    persistStoryboardLibrary();
    els.saveStateBtn.textContent = 'Saved';
    els.saveStateBtn.disabled = true;
    if (showStatus) setStatus('Storyboard saved.');
  } catch (error) {
    els.saveStateBtn.textContent = 'Retry save';
    els.saveStateBtn.disabled = false;
    setStatus(`Storyboard could not be saved: ${error.message}`);
  }
}

function restoreStoryboard() {
  const storyboard = getCurrentStoryboardRecord();
  if (!storyboard) {
    prefillCommonPrompt(els.styleSelect.value);
    return;
  }
  if (state.styles[0]) els.styleSelect.value = state.styles[0].id;
  els.scriptText.value = storyboard.scriptText || '';
  els.sceneCount.value = storyboard.sceneCount || 8;
  els.textProvider.value = ['gemini', 'openai'].includes(storyboard.textProvider) ? storyboard.textProvider : 'gemini';
  els.imageProvider.value = ['gemini', 'openai', 'dezgo', 'stub'].includes(storyboard.imageProvider) ? storyboard.imageProvider : 'gemini';
  state.audioProvider = AUDIO_PROVIDERS_CLIENT.includes(storyboard.audioProvider) ? storyboard.audioProvider : 'stub';
  els.audioProvider.value = state.audioProvider;
  state.voiceMap = storyboard.voiceMap && typeof storyboard.voiceMap === 'object'
    ? { elevenlabs: storyboard.voiceMap.elevenlabs || {}, piper: storyboard.voiceMap.piper || {}, stub: storyboard.voiceMap.stub || {} }
    : { elevenlabs: {}, piper: {}, stub: {} };
  els.commonPromptText.value = storyboard.commonPromptText || '';
  if (storyboard.styleId && state.styles.some((x) => x.id === storyboard.styleId)) els.styleSelect.value = storyboard.styleId;
  if (!els.commonPromptText.value) prefillCommonPrompt(els.styleSelect.value);
  state.scenes = (storyboard.scenes || []).map(normalizeScene);
  state.lastPromptInputs = storyboard.lastPromptInputs
    && typeof storyboard.lastPromptInputs.scriptText === 'string'
    && typeof storyboard.lastPromptInputs.commonPromptText === 'string'
      ? storyboard.lastPromptInputs
      : (state.scenes.length ? getPromptInputs() : null);
  state.serialState = 'idle';
  state.currentSerialIndex = 0;
  state.audioSerialState = 'idle';
  state.currentAudioSerialIndex = 0;
  state.videoSerialState = 'idle';
  state.currentVideoSerialIndex = 0;
  renderScenes();
  renderVoicesPanel();
}

function nextUntitledTitle() {
  const titles = new Set(state.storyboardLibrary.storyboards.map((item) => item.title));
  if (!titles.has('Untitled storyboard')) return 'Untitled storyboard';
  let suffix = 2;
  while (titles.has(`Untitled storyboard ${suffix}`)) suffix += 1;
  return `Untitled storyboard ${suffix}`;
}

async function createNewStoryboard() {
  if (isBusy()) return;
  saveStoryboard(false);
  const styleId = state.styles[0]?.id || 'basic-cartoon';
  const style = state.styles.find((item) => item.id === styleId);
  const storyboard = createStoryboardRecord({
    title: nextUntitledTitle(),
    scriptText: '',
    sceneCount: 8,
    styleId,
    textProvider: 'gemini',
    imageProvider: 'gemini',
    audioProvider: 'stub',
    voiceMap: { elevenlabs: {}, piper: {}, stub: {} },
    commonPromptText: style?.promptText || '',
    lastPromptInputs: null,
    scenes: [],
  });
  state.storyboardLibrary.storyboards.push(storyboard);
  state.storyboardLibrary.currentId = storyboard.id;
  persistStoryboardLibrary();
  renderStoryboardPicker();
  restoreStoryboard();
  await loadStyleReferences(els.styleSelect.value || styleId);
  updateButtons();
  setStatus(`Created ${storyboard.title}. Changes save automatically.`);
}

async function openStoryboard(storyboardId) {
  if (isBusy() || storyboardId === state.storyboardLibrary.currentId) return;
  saveStoryboard(false);
  if (!state.storyboardLibrary.storyboards.some((item) => item.id === storyboardId)) return;
  state.storyboardLibrary.currentId = storyboardId;
  persistStoryboardLibrary();
  restoreStoryboard();
  await loadStyleReferences(els.styleSelect.value || 'basic-cartoon');
  updateButtons();
  setStatus(`Opened ${getCurrentStoryboardRecord()?.title || 'storyboard'}. Changes save automatically.`);
}

async function downloadZip() {
  try {
    setStatus('Building zip...');
    const data = await api('/api/images/zip', {
      method: 'POST',
      body: JSON.stringify({ project: getStoryboard() }),
    });
    const a = document.createElement('a');
    a.href = data.zipPath;
    a.download = '';
    a.click();
    setStatus('ZIP ready.');
  } catch (error) {
    setStatus(`ZIP failed: ${error.message}`);
  }
}

function updateButtons() {
  const busy = isBusy();
  const promptsCanBeGenerated = canGeneratePrompts();
  els.generatePromptsBtn.disabled = busy || !promptsCanBeGenerated;
  els.generatePromptsBtn.textContent = 'Generate prompts';
  els.generatePromptsBtn.title = promptsCanBeGenerated
    ? 'Generate image prompts from the story and visual settings'
    : 'Change the story, script, or common prompt to generate prompts again';
  els.newStoryboardBtn.disabled = busy;
  els.storyboardPicker.disabled = busy;
  els.saveStateBtn.disabled = busy || els.saveStateBtn.textContent !== 'Retry save';
  els.downloadZipBtn.disabled = busy || !state.scenes.some((scene) => scene.versions.length);
  els.characterRefInput.disabled = busy;
  els.worldRefInput.disabled = busy;
  els.audioProvider.disabled = busy;
  els.generateDialogueBtn.disabled = busy || !state.scenes.length;
  els.generateDialogueBtn.textContent = state.scenes.some((scene) => scene.lines.length) ? 'Regenerate dialogue' : 'Generate dialogue';
  configureBatchButton(els.startSerialBtn, {
    noun: 'images',
    generating: state.generating,
    stopRequested: state.stopped,
    serialState: state.serialState,
    canStart: state.scenes.length > 0,
  });
  configureBatchButton(els.startAudioSerialBtn, {
    noun: 'audio',
    generating: state.audioGenerating,
    stopRequested: state.audioStopped,
    serialState: state.audioSerialState,
    canStart: state.scenes.some((scene) => scene.lines.length),
  });
  configureBatchButton(els.startVideoSerialBtn, {
    noun: 'videos',
    generating: state.videoGenerating,
    stopRequested: state.videoStopped,
    serialState: state.videoSerialState,
    canStart: state.scenes.some((scene) => scene.versions.length),
  });
  document.querySelectorAll('.ref-delete-btn, .version-thumb, .audio-version-select:not(.is-current)').forEach((button) => { button.disabled = busy; });
  setLoadingButton(els.generatePromptsBtn, state.operation?.type === 'prompts');
  setLoadingButton(els.generateDialogueBtn, state.operation?.type === 'dialogueAll');
}

function configureBatchButton(button, { noun, generating, stopRequested, serialState, canStart }) {
  button.classList.remove('primary', 'secondary', 'danger');
  button.setAttribute('aria-busy', String(generating));
  if (generating) {
    button.textContent = stopRequested ? 'Stopping…' : `Stop ${noun}`;
    button.classList.add('danger');
    button.disabled = stopRequested;
    return;
  }

  const anotherOperationIsBusy = isBusy();
  if (serialState === 'paused') button.textContent = `Resume ${noun}`;
  else if (serialState === 'failed') button.textContent = `Retry ${noun}`;
  else if (serialState === 'complete') button.textContent = `Regenerate ${noun}`;
  else button.textContent = `Generate ${noun}`;
  button.classList.add(['paused', 'failed'].includes(serialState) ? 'primary' : 'secondary');
  button.disabled = anotherOperationIsBusy || !canStart;
}

function handleImageBatchAction() {
  if (state.generating) stopSerial();
  else if (['paused', 'failed'].includes(state.serialState)) resumeSerial();
  else startSerial(0);
}

function handleAudioBatchAction() {
  if (state.audioGenerating) stopAudioSerial();
  else if (['paused', 'failed'].includes(state.audioSerialState)) resumeAudioSerial();
  else startAudioSerial(0);
}

function handleVideoBatchAction() {
  if (state.videoGenerating) stopVideoSerial();
  else if (['paused', 'failed'].includes(state.videoSerialState)) resumeVideoSerial();
  else startVideoSerial(0);
}

function attachGlobalEvents() {
  els.generatePromptsBtn.addEventListener('click', generatePrompts);
  els.startSerialBtn.addEventListener('click', handleImageBatchAction);
  els.generateDialogueBtn.addEventListener('click', generateDialogue);
  els.startAudioSerialBtn.addEventListener('click', handleAudioBatchAction);
  els.startVideoSerialBtn.addEventListener('click', handleVideoBatchAction);
  els.saveStateBtn.addEventListener('click', () => saveStoryboard(true));
  els.newStoryboardBtn.addEventListener('click', createNewStoryboard);
  els.storyboardPicker.addEventListener('change', (event) => openStoryboard(event.target.value));
  els.downloadZipBtn.addEventListener('click', downloadZip);
  els.styleSelect.addEventListener('change', async () => {
    prefillCommonPrompt(els.styleSelect.value);
    saveStoryboard(false);
    updateButtons();
    await loadStyleReferences(els.styleSelect.value);
  });
  [els.scriptText, els.commonPromptText].forEach((element) => {
    element.addEventListener('input', () => {
      saveStoryboard(false);
      updateButtons();
    });
  });
  els.sceneCount.addEventListener('input', () => saveStoryboard(false));
  [els.textProvider, els.imageProvider].forEach((element) => {
    element.addEventListener('change', () => saveStoryboard(false));
  });
  els.audioProvider.addEventListener('change', async () => {
    state.audioProvider = els.audioProvider.value;
    if (state.audioProvider === 'elevenlabs') await loadElevenLabsVoices();
    renderVoicesPanel();
    saveStoryboard(false);
  });
  els.characterRefInput.addEventListener('change', async (e) => {
    await uploadStyleReferences('characters', e.target.files);
    e.target.value = '';
  });
  els.worldRefInput.addEventListener('change', async (e) => {
    await uploadStyleReferences('world', e.target.files);
    e.target.value = '';
  });
}

async function init() {
  initializeStoryboardLibrary();
  await loadStyles();
  attachGlobalEvents();
  restoreStoryboard();
  renderStoryboardPicker();
  await loadStyleReferences(els.styleSelect.value || 'basic-cartoon');
  if (state.audioProvider === 'elevenlabs') await loadElevenLabsVoices();
  renderVoicesPanel();
  updateButtons();
  saveStoryboard(false);
  setStatus('Ready. Changes save automatically.');
}

init().catch((error) => {
  setStatus(`Application initialization failed: ${error.message}`);
});
