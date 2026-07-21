import { projectStore, sceneStore, generationStore, voiceStore, uiStore, batchStore } from './store.js';
import { getCurrentStoryboardRecord, persistStoryboardLibrary, queueSync } from './persistence.js';
import { loadProtectedAsset } from './assets.js';
import { adaptSceneImageShot, imageShot, setActiveImageVersion } from './scene-shots.js';
import { api } from './api.js';
import { previewVoice, openVoiceLibraryModal } from './voices.js';
import { computeStageStatus, getCachedJobs, getCachedSpend } from './stages.js';

const NO_MAPPING_AUDIO_PROVIDERS = ['stub'];
const PREVIEWABLE_AUDIO_PROVIDERS = ['elevenlabs', 'spark', 'piper'];

const LEGACY_STYLE_PROMPTS = {
  'basic-cartoon': 'Ultra-low detail stick figure illustration of simple shapes and minimal colors. Thick black outlines, flat colors, white or lightly colored background, minimal props, playful composition, crude hand-drawn digital doodle feeling, clean readable silhouette, minimal texture, no realism.',
  'cinematic-reality': 'Cinematic realistic scene with natural lighting, expressive framing, believable environments, detailed subjects, soft depth of field, polished photography-inspired composition, dramatic but grounded mood.',
  'dark-gothic': 'Dark gothic illustration with moody shadows, worn architecture, ominous atmosphere, muted deep palette, dramatic contrast, melancholic tone, haunting but readable composition.',
  'indie-youtuber': 'Clean modern creator aesthetic, expressive thumbnail-friendly composition, bright contrast, approachable personality, casual environments, trendy editorial feel, punchy simplified storytelling.',
  'vox-style': 'Editorial explainer visual language, clean infographic-like composition, simplified shapes, bold framing, smart modern color blocking, crisp design-led illustration, readable information-first storytelling.',
  'money-wolf': 'Pop Art modern illustration, bold shapes, high contrast, playful composition, dynamic layout, saturated colors, commercial editorial feel, expressive dynamic composition.',
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
  if (els.stageStyleSelect) els.stageStyleSelect.replaceChildren();
  generationStore.get().styles.forEach((style) => {
    const option = document.createElement('option');
    option.value = style.id;
    option.textContent = style.name;
    els.styleSelect.appendChild(option);
    if (els.stageStyleSelect) {
      const stageOption = option.cloneNode(true);
      els.stageStyleSelect.appendChild(stageOption);
    }
  });
  const saved = getCurrentStoryboardRecord();
  if (saved?.styleId && generationStore.get().styles.some((x) => x.id === saved.styleId)) {
    els.styleSelect.value = saved.styleId;
  }
  if (els.stageStyleSelect) els.stageStyleSelect.value = els.styleSelect.value;
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

export function renderStyleReferences(els, setStatus) {
  const refs = generationStore.get().styleReferences;
  renderStyleReferenceList(els.characterRefs, refs.characters || [], 'characters', els, setStatus);
  renderStyleReferenceList(els.worldRefs, refs.world || [], 'world', els, setStatus);
}

function renderStyleReferenceList(container, items, type, els, setStatus) {
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
    button.setAttribute('aria-label', `Remove ${item.fileName}`);
    button.title = `Remove ${item.fileName}`;
    button.addEventListener('click', () => deleteStyleReference(type, item.fileName, els, setStatus));
    meta.append(name);
    
    const badge = document.createElement('span');
    badge.className = `style-ref-badge ${item.isUserUploaded ? 'user' : 'system'}`;
    badge.textContent = item.isUserUploaded ? 'User' : 'System';
    
    card.append(image, meta, button, badge);
    container.appendChild(card);
  });
}

export async function loadStyleReferences(styleId, els, setStatus) {
  generationStore.set({ styleReferences: { characters: [], world: [] }, styleReferencesStyleId: null });
  renderStyleReferences(els, setStatus);
  els.styleReferencesPanel.setAttribute('aria-busy', 'true');
  try {
    const data = await api(`/api/styles/${encodeURIComponent(styleId)}/references`);
    if (els.styleSelect.value !== styleId) return;
    generationStore.set({ styleReferences: data.references || { characters: [], world: [] }, styleReferencesStyleId: styleId });
    renderStyleReferences(els, setStatus);
  } catch (error) {
    if (els.styleSelect.value !== styleId) return;
    generationStore.set({ styleReferences: { characters: [], world: [] }, styleReferencesStyleId: null });
    renderStyleReferences(els, setStatus);
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
    generationStore.set({ styleReferences: data.references || { characters: [], world: [] }, styleReferencesStyleId: styleId });
    renderStyleReferences(els, setStatus);
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
    generationStore.set({ styleReferences: data.references || { characters: [], world: [] }, styleReferencesStyleId: styleId });
    renderStyleReferences(els, setStatus);
    if (setStatus) setStatus('Reference removed.');
  } catch (error) {
    if (setStatus) setStatus(`Remove failed: ${error.message}`);
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
  const summary = [line('Planning', status.planning), line('Images', status.images), line('Audio', status.audio), line('Video', status.video), line('Subtitles', status.subtitles)].join(' · ');
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
  const spend = getCachedSpend();

  if (els.stagePlanningStatus) els.stagePlanningStatus.textContent = stageStatusLabel(status.planning);
  if (els.stageImagesStatus) els.stageImagesStatus.textContent = stageStatusLabel(status.images);
  if (els.stageAudioStatus) els.stageAudioStatus.textContent = stageStatusLabel(status.audio);
  if (els.stageVideoStatus) els.stageVideoStatus.textContent = stageStatusLabel(status.video);
  if (els.stageSubtitlesStatus) els.stageSubtitlesStatus.textContent = stageStatusLabel(status.subtitles);
  if (els.stageTokensStatus) {
    els.stageTokensStatus.textContent = spend.totalCostUSD != null ? `${spend.totalCostUSD.toFixed(4)} USD` : '0.0000 USD';
  }

  if (els.stageTokensBtn) {
    els.stageTokensBtn.disabled = true;
    const providerLines = Object.entries(spend.providers || {})
      .map(([provider, stats]) => `${provider}: $${stats.costUSD.toFixed(4)} (${stats.tokens.toLocaleString()} tokens)`)
      .join('\n');
    els.stageTokensBtn.title = providerLines || 'No spend recorded';
  }

  // Read-only status strip — selection now happens only in the Start modal (see openStartRunModal
  // in app.js), so these boxes no longer toggle anything and are always disabled/non-interactive.
  for (const [key, button] of [['planning', els.stagePlanningBtn], ['images', els.stageImagesBtn], ['audio', els.stageAudioBtn], ['video', els.stageVideoBtn], ['subtitles', els.stageSubtitlesBtn]]) {
    if (!button) continue;
    const stage = status[key];
    const hasWork = stage.missing > 0 || stage.stale > 0 || stage.failed > 0;
    button.classList.toggle('is-running', stage.running);
    button.classList.toggle('is-paused', stage.paused);
    // Failed takes priority over "has other actionable work" for the single status color — keep
    // it to one color per box so it reads at a glance.
    button.classList.toggle('status-failed', Boolean(stage.failed));
    button.classList.toggle('status-actionable', hasWork && !stage.failed);
    button.disabled = true;
  }

  // One Start/Stop toggle runs the checked stages from the Start modal (the 99% case is all 4) and
  // doubles as Stop while anything is running — Stop is always resumable, so there's no separate
  // harder-stop control anymore. Targeting a subset of stages/scenes is done inside the modal.
  // `running` must match `busy` exactly: `uiState.operation` is set for every kind of generation,
  // not just batches — a single-scene regenerate from the entity modal (operation.type 'image'/
  // 'audio'/'video'/'prompt'/'action'/'dialogue') sets it too, but batchStore-derived `status[stage]
  // .running` only reflects batch runs. Deriving `running` from just batch/planning state left
  // single-scene operations invisible to the Start button — worse, `disabled = busy && !running`
  // then made the button unusable (disabled, stuck on "Start") for the whole duration of a
  // single-scene generation instead of turning into "Stop".
  const running = busy;

  if (els.startPauseBtn) {
    els.startPauseBtn.textContent = running ? 'Stop' : 'Start';
    els.startPauseBtn.dataset.running = String(running);
    els.startPauseBtn.disabled = busy && !running;
  }

  els.newStoryboardBtn.disabled = busy;
  els.storyboardPickerToggle.disabled = busy;
  els.saveStateBtn.disabled = busy || els.saveStateBtn.textContent !== 'Retry save';
  els.downloadZipBtn.disabled = busy || !sceneState.scenes.some((scene) => imageShot(scene).versions.length);
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

  const uploadsTabBtn = modal.querySelector('.library-tabs .tab-btn[data-tab="uploads"]');
  if (uploadsTabBtn) {
    if (mode === 'character-reference' || mode === 'world-reference') {
      uploadsTabBtn.textContent = 'Style References';
    } else {
      uploadsTabBtn.textContent = 'User Uploads';
    }
  }

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
              body: JSON.stringify({ type: refType, fileName: item.fileName, deleteFile: true }),
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

    const badge = document.createElement('span');
    badge.className = 'library-image-badge';
    if (item.isSystemDefault) {
      badge.textContent = 'System Default';
      badge.classList.add('system');
    } else if (item.path.includes('/user-style-references/')) {
      badge.textContent = 'User Style Reference';
      badge.classList.add('user-style');
    } else {
      badge.textContent = 'User Upload';
      badge.classList.add('user');
    }
    card.appendChild(badge);

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
      generationStore.set({ styleReferences: data.references || { characters: [], world: [] }, styleReferencesStyleId: styleId });
      renderStyleReferences(domEls, setStatus);
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
      generationStore.set({ styleReferences: data.references || { characters: [], world: [] }, styleReferencesStyleId: styleId });
      renderStyleReferences(domEls, setStatus);
      renderActiveList();
      if (setStatus) setStatus(`Removed from active ${type}.`);
    } catch (err) {
      if (setStatus) setStatus(`Failed to remove image: ${err.message}`);
    }
  }
}

async function selectLibraryImage(path, fileName) {
  const { mode, sceneId, domEls, setStatus, styleId } = libraryState;
  const projectId = projectStore.get().currentId;

  if (mode === 'character-reference' || mode === 'world-reference') {
    if (path.startsWith('/style-references/') || path.startsWith('/user-style-references/')) {
      const type = mode === 'character-reference' ? 'characters' : 'world';
      try {
        if (setStatus) setStatus(`Activating ${type} reference...`);
        const data = await api(`/api/styles/${encodeURIComponent(styleId)}/references/activate`, {
          method: 'POST',
          body: JSON.stringify({ type, fileName }),
        });
        generationStore.set({ styleReferences: data.references || { characters: [], world: [] }, styleReferencesStyleId: styleId });
        renderStyleReferences(domEls, setStatus);
        renderActiveList();
        if (setStatus) setStatus(`Activated ${type} reference.`);
      } catch (err) {
        if (setStatus) setStatus(`Failed to activate: ${err.message}`);
      }
    } else {
      await addImageToActive(path, fileName);
    }
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

      const responseScene = adaptSceneImageShot(data.scene);
      const scenes = sceneStore.get().scenes.map(s => s.id === responseScene.id ? responseScene : s);
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
    setActiveImageVersion(next, vIndex);
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

export function populateTokensInfoModal(els) {
  const spend = getCachedSpend() || {};
  const { totalCostUSD = 0, totalTokens = 0, providers = {}, activePrices = [], estimatedPrices = [], videoModels = [] } = spend;

  // 1. Render Active Project Spend Breakdown
  let spendHTML = '';
  
  // Pivot the spend data from provider -> modality -> model to modality -> provider -> model
  const modalityGroups = {
    text: { label: 'Text Generation', icon: '📝', costUSD: 0, items: [] },
    image: { label: 'Image Generation', icon: '🎨', costUSD: 0, items: [] },
    audio: { label: 'Audio Synthesis', icon: '🔊', costUSD: 0, items: [] },
    video: { label: 'Video Generation', icon: '🎬', costUSD: 0, items: [] },
  };

  let hasAnySpend = false;
  for (const [providerName, providerData] of Object.entries(providers)) {
    const pModalities = providerData.modalities || {};
    for (const [modalityName, modalityData] of Object.entries(pModalities)) {
      const targetGroup = modalityGroups[modalityName];
      if (targetGroup) {
        hasAnySpend = true;
        targetGroup.costUSD += modalityData.costUSD;
        
        const models = modalityData.models || {};
        for (const [modelName, modelStats] of Object.entries(models)) {
          targetGroup.items.push({
            provider: providerName,
            model: modelName,
            ...modelStats
          });
        }
      }
    }
  }

  if (!hasAnySpend) {
    spendHTML = `<div class="past-storyboards-placeholder" style="padding: 30px 10px; text-align: center; color: var(--muted);">
      No tokens recorded
    </div>`;
  } else {
    spendHTML = `<div style="margin-bottom: 12px; font-size: 13px; font-weight: 500; display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.02); padding: 10px 16px; border-radius: 8px; border: 1px solid var(--line);">
      <span>Total Storyboard Spend: <strong style="color: var(--accent); font-size: 15px;">$${totalCostUSD.toFixed(5)} USD</strong></span>
      <span>Total Tokens: <strong>${totalTokens.toLocaleString()}</strong></span>
    </div>`;

    spendHTML += `<div class="tokens-spend-grid">`;
    for (const [modality, group] of Object.entries(modalityGroups)) {
      if (group.items.length === 0) continue;
      
      spendHTML += `<div class="tokens-spend-card">
        <h4>
          <span>${group.icon} ${group.label}</span>
          <span class="cost">$${group.costUSD.toFixed(5)}</span>
        </h4>
        <div class="tokens-spend-card-providers">`;
        
      for (const item of group.items) {
        let countDetails = '';
        if (modality === 'text') {
          countDetails = `${item.count} prompt(s) (${item.inputTokens.toLocaleString()} in / ${item.outputTokens.toLocaleString()} out)`;
        } else if (modality === 'image') {
          countDetails = `${item.count} image(s)`;
        } else if (modality === 'audio') {
          const sec = item.extra.bytes ? (item.extra.bytes / (item.model.includes('piper') ? 44100 : 48000)).toFixed(1) : '0';
          countDetails = `${item.count.toLocaleString()} character(s) (~${sec}s audio)`;
        } else if (modality === 'video') {
          countDetails = `${item.count} video(s) (${item.extra.frames || 0} frames total)`;
        }

        spendHTML += `<div class="tokens-spend-provider-row">
          <div class="tokens-spend-provider-header">
            <strong>${item.provider} <span style="font-weight: normal; color: var(--muted); font-size: 11px;">(${item.model})</span></strong>
            <span>$${item.costUSD.toFixed(5)}</span>
          </div>
          <div class="tokens-spend-model-list">
            <div class="tokens-spend-model-row">
              <span>Usage: ${countDetails}</span>
              ${item.tokens > 0 ? `<span>Tokens: ${item.tokens.toLocaleString()}</span>` : ''}
            </div>
          </div>
        </div>`;
      }
      
      spendHTML += `</div></div>`;
    }
    spendHTML += `</div>`;
  }
  
  if (els.tokensSpendContainer) {
    els.tokensSpendContainer.innerHTML = spendHTML;
  }

  // 2. Render Configured Modality Rates
  let pricingHTML = `<table class="tokens-table">
    <thead>
      <tr>
        <th>Provider</th>
        <th>Modality</th>
        <th>Model</th>
        <th>Rate</th>
      </tr>
    </thead>
    <tbody>`;

  // Render Database Configured Prices
  for (const price of activePrices) {
    let rateStr = '';
    const card = price.rateCard || {};
    if (card.type === 'token_components') {
      const comps = card.components || [];
      rateStr = comps.map(c => {
        const ratePerM = c.nanoUsdPerMillion / 1e9;
        const keyLabel = c.usageKey === 'inputTokens' ? 'Input' 
                       : c.usageKey === 'cachedInputTokens' ? 'Cached Input'
                       : c.usageKey === 'outputTokens' ? 'Output'
                       : c.usageKey === 'inputTextTokens' ? 'Input Text'
                       : c.usageKey === 'inputImageTokens' ? 'Input Image'
                       : c.usageKey === 'outputImageTokens' ? 'Output Image'
                       : c.usageKey === 'outputTextOrThinkingTokens' ? 'Output Text/Thinking'
                       : c.usageKey;
        return `${keyLabel}: $${ratePerM.toFixed(4)}/M`;
      }).join(', ');
    } else if (card.type === 'linear_steps') {
      const baseUSD = card.baseNanoUsd / 1e9;
      rateStr = `$${baseUSD.toFixed(4)} per ${card.baseUnits} steps (scaled linearly)`;
    } else if (card.type === 'flat') {
      const rate = card.nanoUsdPerUnit / 1e9;
      rateStr = `$${rate.toFixed(4)} flat rate`;
    } else {
      rateStr = JSON.stringify(card);
    }

    pricingHTML += `<tr>
      <td><strong>${price.provider}</strong></td>
      <td style="text-transform: capitalize;">${price.modality}</td>
      <td><code>${price.model}</code></td>
      <td>${rateStr}</td>
    </tr>`;
  }

  // Render Fallback / Estimated Prices
  for (const est of estimatedPrices) {
    pricingHTML += `<tr>
      <td><strong>${est.provider}</strong></td>
      <td style="text-transform: capitalize;">${est.modality}</td>
      <td><code>${est.model}</code></td>
      <td>${est.rate}</td>
    </tr>`;
  }

  // The usage cards above show video models that have actually run. Also list every supported
  // video model here so Token Details remains useful before the first video generation and so a
  // configured model without a rate card is visible instead of silently omitted.
  const pricedModels = new Set([
    ...activePrices.map((price) => `${price.provider}:${price.modality}:${price.model}`),
    ...estimatedPrices.map((price) => `${price.provider}:${price.modality}:${price.model}`),
  ]);
  for (const video of videoModels) {
    if (pricedModels.has(`${video.provider}:video:${video.model}`)) continue;
    const modeLabels = (video.modes || []).map((mode) => mode.replaceAll('_', ' ')).join(', ');
    pricingHTML += `<tr>
      <td><strong>${video.provider}</strong></td>
      <td style="text-transform: capitalize;">video</td>
      <td><code>${video.model}</code>${video.isDefault ? ' <span style="color: var(--muted);">(default)</span>' : ''}</td>
      <td>Rate not configured${modeLabels ? ` · ${modeLabels}` : ''}</td>
    </tr>`;
  }

  pricingHTML += `</tbody></table>`;
  
  if (els.tokensPricingContainer) {
    els.tokensPricingContainer.innerHTML = pricingHTML;
  }
}
