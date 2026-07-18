import { projectStore, sceneStore, generationStore, voiceStore, uiStore, batchStore } from './store.js';
import { getCurrentStoryboardRecord, persistStoryboardLibrary, queueSync } from './persistence.js';
import { loadProtectedAsset } from './assets.js';
import { api } from './api.js';
import { previewVoice, openVoiceLibraryModal } from './voices.js';
import { computeStageStatus, getCachedJobs, getStageSelection } from './stages.js';
import { suggestSceneCount, suggestSceneCountFromNarration } from './scene-count.js';

const NO_MAPPING_AUDIO_PROVIDERS = ['stub'];
const PREVIEWABLE_AUDIO_PROVIDERS = ['elevenlabs', 'spark', 'piper'];

const LEGACY_STYLE_PROMPTS = {
  'basic-cartoon': 'Ultra-low detail stick figure illustration of simple shapes and minimal colors. Thick black outlines, flat colors, white or lightly colored background, minimal props, playful composition, crude hand-drawn digital doodle feeling, clean readable silhouette, minimal texture, no realism.',
  'cinematic-reality': 'Cinematic realistic scene with natural lighting, expressive framing, believable environments, detailed subjects, soft depth of field, polished photography-inspired composition, dramatic but grounded mood.',
  'dark-gothic': 'Dark gothic illustration with moody shadows, worn architecture, ominous atmosphere, muted deep palette, dramatic contrast, melancholic tone, haunting but readable composition.',
  'indie-youtuber': 'Clean modern creator aesthetic, expressive thumbnail-friendly composition, bright contrast, approachable personality, casual environments, trendy editorial feel, punchy simplified storytelling.',
  'vox-style': 'Editorial explainer visual language, clean infographic-like composition, simplified shapes, bold framing, smart modern color blocking, crisp design-led illustration, readable information-first storytelling.',
};

function migrateLegacyStylePrompt(saved, style, els) {
  const legacy = LEGACY_STYLE_PROMPTS[style?.id];
  if (!saved || !legacy || !String(saved.commonPromptText || '').startsWith(legacy)) return false;
  const suffix = String(saved.commonPromptText).slice(legacy.length).trimStart();
  saved.commonPromptText = [style.promptText, suffix].filter(Boolean).join('\n');
  els.commonPromptText.value = saved.commonPromptText;
  return true;
}

export function renderStoryboardPicker(els) {
  const state = projectStore.get();
  const current = state.storyboards.find((storyboard) => storyboard.id === state.currentId);
  if (els.storyboardTitle) els.storyboardTitle.value = current?.title || 'Untitled';
  els.storyboardPickerList.replaceChildren();
  state.storyboards
    .slice()
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .forEach((storyboard) => {
      const item = document.createElement('li');
      item.setAttribute('role', 'option');
      item.dataset.id = storyboard.id;
      item.textContent = storyboard.title;
      item.setAttribute('aria-selected', String(storyboard.id === state.currentId));
      els.storyboardPickerList.appendChild(item);
    });
}

export async function loadStyles(els) {
  const data = await api('/api/styles');
  generationStore.set({ styles: data.styles || [] });
  els.styleSelect.replaceChildren();
  generationStore.get().styles.forEach((style) => {
    const option = document.createElement('option');
    option.value = style.id;
    option.textContent = style.name;
    els.styleSelect.appendChild(option);
  });
  const saved = getCurrentStoryboardRecord();
  if (saved?.styleId && generationStore.get().styles.some((x) => x.id === saved.styleId)) {
    els.styleSelect.value = saved.styleId;
  }
  const selectedStyle = generationStore.get().styles.find((item) => item.id === els.styleSelect.value);
  if (migrateLegacyStylePrompt(saved, selectedStyle, els)) {
    persistStoryboardLibrary();
    queueSync(saved);
  } else if (!saved?.commonPromptText) {
    prefillCommonPrompt(els.styleSelect.value, els);
  }
}

export function prefillCommonPrompt(styleId, els) {
  const style = generationStore.get().styles.find((item) => item.id === styleId);
  els.commonPromptText.value = style?.promptText || '';
}

export function renderStyleReferences(els) {
  const refs = generationStore.get().styleReferences;
  renderStyleReferenceList(els.characterRefs, refs.characters || [], 'characters', els);
  renderStyleReferenceList(els.worldRefs, refs.world || [], 'world', els);
}

function renderStyleReferenceList(container, items, type, els) {
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
    
    loadProtectedAsset(item.url).then(url => { if (url) image.src = url; });
    image.alt = item.fileName;
    image.loading = 'lazy';
    image.decoding = 'async';
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
    button.addEventListener('click', () => deleteStyleReference(type, item.fileName, els));
    meta.append(name);
    card.append(image, meta, button);
    container.appendChild(card);
  });
}

export async function loadStyleReferences(styleId, els, setStatus) {
  generationStore.set({ styleReferences: { characters: [], world: [] } });
  renderStyleReferences(els);
  els.styleReferencesPanel.setAttribute('aria-busy', 'true');
  try {
    const data = await api(`/api/styles/${encodeURIComponent(styleId)}/references`);
    if (els.styleSelect.value !== styleId) return;
    generationStore.set({ styleReferences: data.references || { characters: [], world: [] } });
    renderStyleReferences(els);
  } catch (error) {
    if (els.styleSelect.value !== styleId) return;
    generationStore.set({ styleReferences: { characters: [], world: [] } });
    renderStyleReferences(els);
    if (setStatus) setStatus(`Could not load references: ${error.message}`);
  } finally {
    if (els.styleSelect.value === styleId) els.styleReferencesPanel.removeAttribute('aria-busy');
  }
}

export async function uploadStyleReferences(type, files, els, setStatus) {
  if (!files?.length) return;
  try {
    if (setStatus) setStatus(`Uploading ${type} references...`);
    const form = new FormData();
    [...files].forEach((file) => form.append('files', file));
    const styleId = els.styleSelect.value;
    const data = await api(`/api/styles/${encodeURIComponent(styleId)}/references/upload?type=${encodeURIComponent(type)}`, {
      method: 'POST',
      body: form,
    });
    generationStore.set({ styleReferences: data.references || { characters: [], world: [] } });
    renderStyleReferences(els);
    if (setStatus) setStatus(`${type} references uploaded.`);
  } catch (error) {
    if (setStatus) setStatus(`Reference upload failed: ${error.message}`);
  }
}

async function deleteStyleReference(type, fileName, els, setStatus) {
  try {
    const styleId = els.styleSelect.value;
    const data = await api(`/api/styles/${encodeURIComponent(styleId)}/references`, {
      method: 'DELETE',
      body: JSON.stringify({ type, fileName }),
    });
    generationStore.set({ styleReferences: data.references || { characters: [], world: [] } });
    renderStyleReferences(els);
    if (setStatus) setStatus('Reference deleted.');
  } catch (error) {
    if (setStatus) setStatus(`Delete failed: ${error.message}`);
  }
}

export function renderVoicesPanel(els) {
  const state = voiceStore.get();
  const provider = state.audioProvider;
  const narratorVoice = state.narratorVoice[provider] || null;
  const availableVoices = PREVIEWABLE_AUDIO_PROVIDERS.includes(provider) ? (state.availableVoices[provider] || []) : [];


  els.voicesPanel.innerHTML = '';

  if (NO_MAPPING_AUDIO_PROVIDERS.includes(provider)) {
    els.voicesPanel.classList.remove('voice-unmapped');
    const note = document.createElement('span');
    note.className = 'voice-note';
    note.textContent = 'Auto-assigned';
    els.voicesPanel.appendChild(note);
    return;
  }

  const select = document.createElement('select');
  select.disabled = uiStore.get().operation != null;
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = availableVoices.length ? 'Choose a voice...' : 'No voices loaded';
  select.appendChild(blank);

  if (provider === 'spark') {
    const cloneOption = document.createElement('option');
    cloneOption.value = 'clone';
    cloneOption.textContent = 'Clone Voice...';
    select.appendChild(cloneOption);
  }

  availableVoices.forEach((voice) => {
    const option = document.createElement('option');
    option.value = voice.voiceId;
    option.textContent = voice.label || voice.voiceId;
    select.appendChild(option);
  });
  select.value = narratorVoice?.voiceId || '';
  els.voicesPanel.classList.toggle('voice-unmapped', !narratorVoice?.voiceId);

  const previewBtn = document.createElement('button');
  previewBtn.type = 'button';
  previewBtn.className = 'secondary text-button voice-preview-btn';
  previewBtn.textContent = '▶';
  previewBtn.title = 'Preview this voice';
  previewBtn.setAttribute('aria-label', 'Preview selected voice');
  previewBtn.disabled = !select.value || select.value === 'clone';
  previewBtn.addEventListener('click', () => {
    const chosen = availableVoices.find((voice) => voice.voiceId === select.value);
    previewVoice(provider, chosen, (msg) => { if (els.statusText) els.statusText.textContent = msg; });
  });

  select.addEventListener('change', () => {
    if (select.value === 'clone') {
      select.value = narratorVoice?.voiceId || '';
      openVoiceLibraryModal(els, (msg) => { if (els.statusText) els.statusText.textContent = msg; });
      return;
    }

    const chosen = availableVoices.find((voice) => voice.voiceId === select.value);
    previewBtn.disabled = !chosen;

    voiceStore.set(s => ({
      narratorVoice: { ...s.narratorVoice, [provider]: chosen ? { voiceId: chosen.voiceId, label: chosen.label } : null },
    }));

    els.voicesPanel.classList.toggle('voice-unmapped', !voiceStore.get().narratorVoice[provider]?.voiceId);
    const record = getCurrentStoryboardRecord();
    if (record) {
      record.narratorVoice = voiceStore.get().narratorVoice;
      queueSync(record);
    }
  });

  els.voicesPanel.append(select, previewBtn);
}

const PLANNING_OPERATION_TYPES = ['prompts', 'dialogueAll', 'prompt', 'dialogue', 'action', 'splitScene', 'planningStaleUpdate'];

function stageStatusLabel(stage) {
  if (!stage.total && stage.done === 0 && stage.missing === 0) return 'Not started';
  let label = stage.label;
  if (stage.paused) label += ' · paused';
  else if (stage.running) label += ' · running';
  return label;
}

function renderGenerationSummary(els, status) {
  if (!els.generationSummaryText) return;
  const line = (label, stage) => `${label} ${stage.done}/${stage.total || 0}${stage.stale ? ` (${stage.stale} stale)` : ''}${stage.failed ? ` (${stage.failed} failed)` : ''}`;
  const summary = [line('Planning', status.planning), line('Images', status.images), line('Audio', status.audio), line('Video', status.video)].join(' · ');
  els.generationSummaryText.textContent = summary;
  els.generationSummaryText.title = summary;
}

// Replaces the old flat 5-button `updateButtons` — the top-level UX is now Planning/Images/Audio/Video
// stage boxes (with room for a running spinner) plus one Start/Pause toggle and a Cancel button,
// driven by `computeStageStatus` (modules/stages.js). Scene-level controls are untouched by this
// function; targeting a single stage is done by clicking directly on that stage's box.
export function renderStageBar(els) {
  const uiState = uiStore.get();
  const sceneState = sceneStore.get();
  const batchState = batchStore.get();
  const record = getCurrentStoryboardRecord();
  const busy = uiState.operation != null;

  const status = computeStageStatus(sceneState.scenes, batchState, uiState.operation, getCachedJobs(), record?.stageRuns || {});

  els.stagePlanningStatus.textContent = stageStatusLabel(status.planning);
  els.stageImagesStatus.textContent = stageStatusLabel(status.images);
  els.stageAudioStatus.textContent = stageStatusLabel(status.audio);
  els.stageVideoStatus.textContent = stageStatusLabel(status.video);

  const selection = getStageSelection(status);
  for (const [key, button] of [['planning', els.stagePlanningBtn], ['images', els.stageImagesBtn], ['audio', els.stageAudioBtn], ['video', els.stageVideoBtn]]) {
    const stage = status[key];
    const hasWork = stage.missing > 0 || stage.stale > 0 || stage.failed > 0;
    button.classList.toggle('is-running', stage.running);
    button.classList.toggle('is-paused', stage.paused);
    // Failed takes priority over "has other actionable work" for the single status color — keep
    // it to one color per box so it reads at a glance.
    button.classList.toggle('status-failed', Boolean(stage.failed));
    button.classList.toggle('status-actionable', hasWork && !stage.failed);
    button.classList.toggle('is-selected', Boolean(selection[key]));
    button.setAttribute('aria-pressed', String(Boolean(selection[key])));
    // Never permanently disabled for "nothing detected to do" — our staleness tracking is a
    // heuristic, not a complete picture (it can't see e.g. a server-side prompt-logic change), so
    // the user must always be able to select a box and force a run. Only disabled while busy.
    button.disabled = busy;
  }

  // One Start/Pause toggle runs the full Planning -> Images -> Audio -> Video sequence by default
  // (the 99% case) and doubles as Pause while anything is running; Cancel is a separate, harder
  // stop, disabled until something is actually running. Targeting a single stage instead is done by
  // clicking directly on that stage's box, not through this control.
  const activeMediaStage = ['images', 'audio', 'video'].find((stage) => status[stage].running);
  const planningActive = Boolean(uiState.operation && PLANNING_OPERATION_TYPES.includes(uiState.operation.type));
  const running = Boolean(activeMediaStage) || planningActive;

  els.startPauseBtn.textContent = running ? 'Pause' : 'Start';
  els.startPauseBtn.dataset.running = String(running);
  els.startPauseBtn.disabled = busy && !running;
  els.cancelRunBtn.disabled = !running;

  if (els.settingsSceneCountInput) {
    const isAutoChecked = els.settingsSceneCountAutoCheckbox && els.settingsSceneCountAutoCheckbox.checked;
    els.settingsSceneCountInput.disabled = busy || isAutoChecked;
  }
  if (els.settingsSceneCountAutoCheckbox) {
    els.settingsSceneCountAutoCheckbox.disabled = busy;
  }
  if (els.settingsSceneCountAutoBtn) {
    const isAutoChecked = els.settingsSceneCountAutoCheckbox && els.settingsSceneCountAutoCheckbox.checked;
    let estimate = null;
    const scenes = sceneStore.get().scenes;
    if (scenes && scenes.length > 0) {
      estimate = suggestSceneCountFromNarration(scenes);
    }
    if (!estimate || estimate <= 0) {
      const scriptText = String(els.scriptText?.value || '').trim();
      if (scriptText) {
        estimate = suggestSceneCount(scriptText);
      }
    }
    els.settingsSceneCountAutoBtn.disabled = busy || !estimate || isAutoChecked;
  }
  els.newStoryboardBtn.disabled = busy;
  els.storyboardPickerToggle.disabled = busy;
  els.saveStateBtn.disabled = busy || els.saveStateBtn.textContent !== 'Retry save';
  els.downloadZipBtn.disabled = busy || !sceneState.scenes.some((scene) => scene.versions.length);
  els.characterRefInput.disabled = busy;
  els.worldRefInput.disabled = busy;
  els.audioProvider.disabled = busy;
  document.querySelectorAll('.ref-delete-btn, .version-thumb, .audio-version-select:not(.is-current)').forEach((button) => { button.disabled = busy; });

  renderGenerationSummary(els, status);
}

// Reusable Image Library Modal State & Logic
let libraryState = {
  mode: '', // 'character-reference', 'world-reference', 'scene-image'
  styleId: '',
  sceneId: '',
  sceneNumber: 1,
  sceneTitle: '',
  domEls: null,
  setStatus: null,
  activeTab: 'uploads',
  uploads: [],
  generations: [],
  pastStoryboards: [],
  hasRetrievedPast: false
};

export function initImageLibraryModal(domEls, setStatus) {
  const modal = document.getElementById('imageLibraryModal');
  if (!modal) return;

  const closeBtn = document.getElementById('closeImageLibraryBtn');
  const doneBtn = document.getElementById('closeImageLibraryDoneBtn');
  const generateBtn = document.getElementById('libraryGenerateBtn');
  const uploadInput = document.getElementById('libraryUploadInput');
  const useStoryCheckbox = document.getElementById('libraryUseStory');
  const providerSelect = document.getElementById('libraryProviderSelect');
  const promptTextarea = document.getElementById('libraryAiPrompt');
  const retrievePastBtn = document.getElementById('libraryRetrievePastBtn');
  const tabButtons = modal.querySelectorAll('.library-tabs .tab-btn');

  domEls.characterRefLibraryBtn?.addEventListener('click', () => {
    openImageLibrary({
      mode: 'character-reference',
      styleId: domEls.styleSelect.value,
      domEls,
      setStatus
    });
  });

  domEls.worldRefLibraryBtn?.addEventListener('click', () => {
    openImageLibrary({
      mode: 'world-reference',
      styleId: domEls.styleSelect.value,
      domEls,
      setStatus
    });
  });

  closeBtn?.addEventListener('click', () => modal.close());
  doneBtn?.addEventListener('click', () => modal.close());

  generateBtn?.addEventListener('click', async () => {
    const userPrompt = promptTextarea.value.trim();
    const useStory = useStoryCheckbox.checked;
    const provider = providerSelect.value;
    const styleId = libraryState.styleId;
    const projectId = projectStore.get().currentId;

    if (!projectId) return;
    if (!userPrompt && !useStory) {
      alert('Please enter a prompt or check "Use story".');
      return;
    }

    const controls = modal.querySelector('.ai-generator-controls');
    controls?.classList.add('is-generating');
    try {
      const data = await api(`/api/projects/${encodeURIComponent(projectId)}/images/generate-reference`, {
        method: 'POST',
        body: JSON.stringify({ userPrompt, useStory, provider, styleId, mode: libraryState.mode })
      });
      promptTextarea.value = '';
      await refreshLibraryLists(projectId, styleId);
      if (libraryState.mode === 'character-reference' || libraryState.mode === 'world-reference') {
        await addImageToActive(data.path, data.fileName);
      } else if (libraryState.mode === 'scene-image') {
        await selectLibraryImage(data.path, data.fileName);
      }
    } catch (err) {
      alert(`Generation failed: ${err.message}`);
    } finally {
      controls?.classList.remove('is-generating');
    }
  });

  uploadInput?.addEventListener('change', async (event) => {
    const files = event.target.files;
    if (!files || !files.length) return;

    const projectId = projectStore.get().currentId;
    if (!projectId) return;

    if (setStatus) setStatus('Uploading library images...');
    const form = new FormData();
    [...files].forEach(file => form.append('files', file));

    try {
      const data = await api(`/api/projects/${encodeURIComponent(projectId)}/images/upload-reference`, {
        method: 'POST',
        body: form
      });
      event.target.value = '';
      await refreshLibraryLists(projectId, libraryState.styleId);
      if (setStatus) setStatus('Uploaded images to library.');
      if (data.files && data.files.length > 0) {
        for (const fileRecord of data.files) {
          if (libraryState.mode === 'character-reference' || libraryState.mode === 'world-reference') {
            await addImageToActive(fileRecord.path, fileRecord.fileName);
          }
        }
      }
    } catch (err) {
      if (setStatus) setStatus(`Upload failed: ${err.message}`);
      alert(`Upload failed: ${err.message}`);
    }
  });

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      tabButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      libraryState.activeTab = tab;

      modal.querySelectorAll('.library-tab-content .tab-pane').forEach(pane => {
        pane.style.display = 'none';
      });
      
      if (tab === 'uploads') {
        document.getElementById('libraryTabUploads').style.display = 'grid';
      } else if (tab === 'generations') {
        document.getElementById('libraryTabGenerations').style.display = 'grid';
      } else if (tab === 'past') {
        document.getElementById('libraryTabPast').style.display = 'block';
        if (libraryState.hasRetrievedPast) {
          document.getElementById('libraryPastList').style.display = 'grid';
          document.querySelector('.past-storyboards-placeholder').style.display = 'none';
        } else {
          document.getElementById('libraryPastList').style.display = 'none';
          document.querySelector('.past-storyboards-placeholder').style.display = 'block';
        }
      }
    });
  });

  retrievePastBtn?.addEventListener('click', async () => {
    const projectId = projectStore.get().currentId;
    if (!projectId) return;

    retrievePastBtn.disabled = true;
    retrievePastBtn.textContent = 'Retrieving...';
    try {
      const data = await api(`/api/projects/${encodeURIComponent(projectId)}/assets/past-storyboards`);
      libraryState.pastStoryboards = data.pastStoryboards || [];
      libraryState.hasRetrievedPast = true;
      renderPastStoryboardsList();
      document.getElementById('libraryPastList').style.display = 'grid';
      document.querySelector('.past-storyboards-placeholder').style.display = 'none';
    } catch (err) {
      alert(`Failed to retrieve past storyboards: ${err.message}`);
      retrievePastBtn.disabled = false;
      retrievePastBtn.textContent = 'Retrieve Past Storyboard Images';
    }
  });
}

export async function openImageLibrary({ mode, styleId, sceneId, sceneNumber, sceneTitle, domEls, setStatus }) {
  const modal = document.getElementById('imageLibraryModal');
  if (!modal) return;

  libraryState = {
    mode,
    styleId: styleId || '',
    sceneId: sceneId || '',
    sceneNumber: sceneNumber || 1,
    sceneTitle: sceneTitle || '',
    domEls,
    setStatus,
    activeTab: 'uploads',
    uploads: [],
    generations: [],
    pastStoryboards: [],
    hasRetrievedPast: false
  };

  modal.querySelectorAll('.library-tabs .tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === 'uploads');
  });
  modal.querySelectorAll('.library-tab-content .tab-pane').forEach(pane => {
    pane.style.display = pane.id === 'libraryTabUploads' ? 'grid' : 'none';
  });

  document.getElementById('libraryAiPrompt').value = '';
  document.getElementById('libraryUseStory').checked = false;
  document.getElementById('libraryRetrievePastBtn').disabled = false;
  document.getElementById('libraryRetrievePastBtn').textContent = 'Retrieve Past Storyboard Images';

  const contextLabel = document.getElementById('imageLibraryModalContextLabel');
  const modalTitle = document.getElementById('imageLibraryModalTitle');
  const activeLabel = document.getElementById('libraryActiveSectionLabel');

  if (mode === 'character-reference') {
    contextLabel.textContent = 'Style References > Character';
    modalTitle.textContent = 'Character Reference Library';
    activeLabel.textContent = 'Active character reference images';
  } else if (mode === 'world-reference') {
    contextLabel.textContent = 'Style References > World';
    modalTitle.textContent = 'World Reference Library';
    activeLabel.textContent = 'Active world reference images';
  } else if (mode === 'scene-image') {
    contextLabel.textContent = `Scene ${sceneNumber} Image`;
    modalTitle.textContent = `Scene Image Library`;
    activeLabel.textContent = `Versions for this scene`;
  }

  modal.showModal();

  const projectId = projectStore.get().currentId;
  if (projectId) {
    await refreshLibraryLists(projectId, styleId);
  }
}

async function refreshLibraryLists(projectId, styleId) {
  try {
    const data = await api(`/api/projects/${encodeURIComponent(projectId)}/assets/library?styleId=${encodeURIComponent(styleId || '')}`);
    libraryState.uploads = data.uploads || [];
    libraryState.generations = data.generations || [];
    renderActiveList();
    renderLibraryGrids();
  } catch (err) {
    console.error('Failed to load library:', err);
  }
}

function renderActiveList() {
  const container = document.getElementById('libraryActiveList');
  container.innerHTML = '';
  const { mode, styleId, sceneId } = libraryState;

  let activeItems = [];
  if (mode === 'character-reference' || mode === 'world-reference') {
    const type = mode === 'character-reference' ? 'characters' : 'world';
    const refs = generationStore.get().styleReferences;
    activeItems = (refs[type] || []).map(ref => ({
      path: ref.url,
      fileName: ref.fileName,
      isActive: true
    }));
  } else if (mode === 'scene-image') {
    const scene = sceneStore.get().scenes.find(s => s.id === sceneId);
    const versions = scene?.versions || [];
    activeItems = versions.map((ver, idx) => ({
      path: ver.path,
      fileName: ver.prompt || 'Scene version',
      index: idx,
      isActive: idx === scene.activeVersionIndex
    }));
  }

  if (!activeItems.length) {
    container.innerHTML = '<div class="library-image-empty">No active images. Select or generate one below.</div>';
    return;
  }

  activeItems.forEach(item => {
    const card = document.createElement('div');
    card.className = `library-image-card${item.isActive ? ' active' : ''}`;
    const img = document.createElement('img');
    loadProtectedAsset(item.path).then(src => { if (src) img.src = src; });
    img.alt = item.fileName;
    img.title = item.fileName;

    const actions = document.createElement('div');
    actions.className = 'library-image-card-actions';

    if (mode === 'scene-image') {
      const selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.textContent = item.isActive ? 'Active' : 'Make Active';
      selectBtn.addEventListener('click', () => {
        if (!item.isActive) {
          selectSceneVersion(item.index);
        }
      });
      actions.appendChild(selectBtn);
    } else {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => removeImageFromActive(item.path, item.fileName));
      actions.appendChild(removeBtn);
    }

    card.appendChild(img);
    card.appendChild(actions);
    container.appendChild(card);
  });
}

function renderLibraryGrids() {
  const uploadsContainer = document.getElementById('libraryTabUploads');
  const gensContainer = document.getElementById('libraryTabGenerations');
  renderLibraryGrid(uploadsContainer, libraryState.uploads, 'uploads');
  renderLibraryGrid(gensContainer, libraryState.generations, 'generations');
}

function renderLibraryGrid(container, items, type) {
  container.innerHTML = '';
  if (!items.length) {
    container.innerHTML = '<div class="library-image-empty">No images found in this section.</div>';
    return;
  }

  const projectId = projectStore.get().currentId;
  const seenPaths = new Set();
  const uniqueItems = items.filter(item => {
    if (seenPaths.has(item.path)) return false;
    seenPaths.add(item.path);
    return true;
  });

  uniqueItems.forEach(item => {
    const card = document.createElement('div');
    card.className = 'library-image-card';
    const img = document.createElement('img');
    loadProtectedAsset(item.path).then(src => { if (src) img.src = src; });
    img.alt = item.fileName;
    img.title = item.fileName;

    const actions = document.createElement('div');
    actions.className = 'library-image-card-actions';

    const useBtn = document.createElement('button');
    useBtn.type = 'button';
    useBtn.textContent = 'Use';
    useBtn.addEventListener('click', () => selectLibraryImage(item.path, item.fileName));

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', async () => {
      if (confirm('Are you sure you want to delete this library image?')) {
        try {
          if (item.path.includes('/user-style-references/')) {
            const styleId = libraryState.styleId;
            const refType = item.type || (libraryState.mode === 'character-reference' ? 'characters' : 'world');
            await api(`/api/styles/${encodeURIComponent(styleId)}/references`, {
              method: 'DELETE',
              body: JSON.stringify({ type: refType, fileName: item.fileName }),
            });
          } else {
            const assetType = item.type || 'ai-references';
            await api(`/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetType)}/${encodeURIComponent(item.fileName)}`, {
              method: 'DELETE'
            });
          }
          await refreshLibraryLists(projectId, libraryState.styleId);
        } catch (err) {
          alert(`Delete failed: ${err.message}`);
        }
      }
    });

    actions.appendChild(useBtn);
    if (!item.path.startsWith('/style-references/')) {
      actions.appendChild(deleteBtn);
    }
    card.appendChild(img);
    card.appendChild(actions);
    container.appendChild(card);
  });
}

function renderPastStoryboardsList() {
  const container = document.getElementById('libraryPastList');
  container.innerHTML = '';
  const items = libraryState.pastStoryboards;

  if (!items.length) {
    container.innerHTML = '<div class="library-image-empty">No past storyboard images found.</div>';
    return;
  }

  items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'library-image-card';
    const img = document.createElement('img');
    loadProtectedAsset(item.path).then(src => { if (src) img.src = src; });
    img.alt = item.sceneTitle || 'Past Scene';

    const meta = document.createElement('div');
    meta.className = 'library-past-card-meta';
    meta.textContent = `${item.projectTitle} - Scene ${item.sceneTitle}`;

    const actions = document.createElement('div');
    actions.className = 'library-image-card-actions';

    const useBtn = document.createElement('button');
    useBtn.type = 'button';
    useBtn.textContent = 'Use';
    useBtn.addEventListener('click', () => selectLibraryImage(item.path, 'past-storyboard-image.png'));

    actions.appendChild(useBtn);
    card.appendChild(img);
    card.appendChild(meta);
    card.appendChild(actions);
    container.appendChild(card);
  });
}

async function addImageToActive(path, fileName) {
  const { mode, styleId, domEls, setStatus } = libraryState;
  if (mode === 'character-reference' || mode === 'world-reference') {
    const type = mode === 'character-reference' ? 'characters' : 'world';
    try {
      const response = await fetch(path);
      const blob = await response.blob();
      const file = new File([blob], fileName || 'reference.png', { type: blob.type });

      if (setStatus) setStatus(`Adding to active ${type}...`);
      const form = new FormData();
      form.append('files', file);
      const data = await api(`/api/styles/${encodeURIComponent(styleId)}/references/upload?type=${encodeURIComponent(type)}`, {
        method: 'POST',
        body: form
      });
      generationStore.set({ styleReferences: data.references || { characters: [], world: [] } });
      renderStyleReferences(domEls);
      renderActiveList();
      if (setStatus) setStatus(`Added to active ${type}.`);
    } catch (err) {
      if (setStatus) setStatus(`Failed to add image: ${err.message}`);
    }
  }
}

async function removeImageFromActive(path, fileName) {
  const { mode, styleId, domEls, setStatus } = libraryState;
  if (mode === 'character-reference' || mode === 'world-reference') {
    const type = mode === 'character-reference' ? 'characters' : 'world';
    try {
      if (setStatus) setStatus(`Removing from active ${type}...`);
      const data = await api(`/api/styles/${encodeURIComponent(styleId)}/references`, {
        method: 'DELETE',
        body: JSON.stringify({ type, fileName }),
      });
      generationStore.set({ styleReferences: data.references || { characters: [], world: [] } });
      renderStyleReferences(domEls);
      renderActiveList();
      if (setStatus) setStatus(`Removed from active ${type}.`);
    } catch (err) {
      if (setStatus) setStatus(`Failed to remove image: ${err.message}`);
    }
  }
}

async function selectLibraryImage(path, fileName) {
  const { mode, sceneId, domEls, setStatus } = libraryState;
  const projectId = projectStore.get().currentId;

  if (mode === 'character-reference' || mode === 'world-reference') {
    await addImageToActive(path, fileName);
  } else if (mode === 'scene-image') {
    try {
      if (setStatus) setStatus('Attaching image version to scene...');
      const response = await fetch(path);
      const blob = await response.blob();
      const file = new File([blob], fileName || 'scene-image.png', { type: blob.type });

      const form = new FormData();
      form.append('file', file);

      const data = await api(`/api/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}/images/upload`, {
        method: 'POST',
        body: form
      });

      const scenes = sceneStore.get().scenes.map(s => s.id === data.scene.id ? data.scene : s);
      sceneStore.set({ scenes });
      const record = getCurrentStoryboardRecord();
      if (record) {
        record.scenes = scenes;
        record.revision = data.revision;
        queueSync(record);
      }

      renderActiveList();
      if (setStatus) setStatus('Scene image updated.');
    } catch (err) {
      alert(`Failed to set scene image: ${err.message}`);
    }
  }
}

function selectSceneVersion(vIndex) {
  const { sceneId } = libraryState;
  const scenes = sceneStore.get().scenes.map(s => {
    if (s.id !== sceneId) return s;
    const next = { ...s };
    next.activeVersionIndex = vIndex;
    next.activeVisualType = 'image';
    return next;
  });
  sceneStore.set({ scenes });
  const record = getCurrentStoryboardRecord();
  if (record) {
    record.scenes = scenes;
    queueSync(record);
  }
  renderActiveList();
}

