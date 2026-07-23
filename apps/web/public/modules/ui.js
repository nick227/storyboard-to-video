import { projectStore, sceneStore, generationStore, voiceStore, uiStore, batchStore } from './store.js';
import { getCurrentStoryboardRecord, persistStoryboardLibrary, queueSync } from './persistence.js';
import { loadProtectedAsset } from './assets.js';
import { imageShot } from './scene-shots.js';
import { api } from './api.js';
import { previewVoice, stopPreviewVoice, openVoiceLibraryModal } from './voices.js';
import { computeStageStatus, getCachedJobs, getCachedSpend } from './stages.js';
import {
  initImageLibraryModal as initImageLibraryController,
  openImageLibrary as openImageLibraryController,
} from './image-library-controller.js';
import { renderTokenDetails } from './token-details.js';

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
  renderStyleReferenceOperationState(els);
}

export function renderStyleReferenceOperationState(els) {
  const busy = Boolean(uiStore.get().operation);
  for (const container of [els.characterRefs, els.worldRefs]) {
    container?.querySelectorAll('.ref-delete-btn').forEach((button) => { button.disabled = busy; });
  }
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

  items.forEach((item, index) => {
    const card = document.createElement('div');
    card.className = 'style-ref-item';
    const image = document.createElement('img');
    image.className = 'style-ref-thumb';
    loadProtectedAsset(item.url).then(url => { if (url) image.src = url; });
    image.alt = item.fileName;
    image.loading = 'lazy';
    image.decoding = 'async';
    if (els.onStyleReferenceInspect) {
      image.tabIndex = 0;
      image.style.cursor = 'zoom-in';
      image.addEventListener('click', () => els.onStyleReferenceInspect(item));
    }
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

    if (els.onStyleReferenceReorder) {
      const order = document.createElement('div');
      order.className = 'style-ref-order';
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'ref-order-btn';
      up.textContent = '↑';
      up.setAttribute('aria-label', `Move ${item.fileName} earlier`);
      up.disabled = index === 0;
      up.addEventListener('click', () => els.onStyleReferenceReorder(type, item.fileName, 'up'));
      const down = document.createElement('button');
      down.type = 'button';
      down.className = 'ref-order-btn';
      down.textContent = '↓';
      down.setAttribute('aria-label', `Move ${item.fileName} later`);
      down.disabled = index === items.length - 1;
      down.addEventListener('click', () => els.onStyleReferenceReorder(type, item.fileName, 'down'));
      order.append(up, down);
      card.append(order);
    }

    container.appendChild(card);
  });
}

// Reference files have no order concept server-side (they're just files in a directory) -- display
// order is a purely client-side project-document field (record.styleReferenceOrder), so a stable
// sort here is the only place that needs to know about it.
function sortReferencesByOrder(items, order) {
  if (!Array.isArray(order) || !order.length) return items;
  const rank = new Map(order.map((fileName, index) => [fileName, index]));
  return [...items].sort((a, b) => (rank.has(a.fileName) ? rank.get(a.fileName) : Infinity) - (rank.has(b.fileName) ? rank.get(b.fileName) : Infinity));
}

function applyStyleReferenceOrder(references) {
  const order = getCurrentStoryboardRecord()?.styleReferenceOrder || {};
  return {
    characters: sortReferencesByOrder(references.characters || [], order.characters),
    world: sortReferencesByOrder(references.world || [], order.world),
  };
}

export async function loadStyleReferences(styleId, els, setStatus) {
  generationStore.set({ styleReferences: { characters: [], world: [] }, styleReferencesStyleId: null });
  renderStyleReferences(els, setStatus);
  els.styleReferencesPanel.setAttribute('aria-busy', 'true');
  try {
    const data = await api(`/api/styles/${encodeURIComponent(styleId)}/references`);
    if (els.styleSelect.value !== styleId) return;
    generationStore.set({ styleReferences: applyStyleReferenceOrder(data.references || { characters: [], world: [] }), styleReferencesStyleId: styleId });
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
    generationStore.set({ styleReferences: applyStyleReferenceOrder(data.references || { characters: [], world: [] }), styleReferencesStyleId: styleId });
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
    generationStore.set({ styleReferences: applyStyleReferenceOrder(data.references || { characters: [], world: [] }), styleReferencesStyleId: styleId });
    renderStyleReferences(els, setStatus);
    if (setStatus) setStatus('Reference removed.');
  } catch (error) {
    if (setStatus) setStatus(`Remove failed: ${error.message}`);
  }
}

function renderVoicePicker(els, container) {
  if (!container) return;
  const state = voiceStore.get();
  const provider = state.audioProvider;
  const narratorVoice = state.narratorVoice[provider] || null;
  const availableVoices = PREVIEWABLE_AUDIO_PROVIDERS.includes(provider) ? (state.availableVoices[provider] || []) : [];

  container.innerHTML = '';

  if (NO_MAPPING_AUDIO_PROVIDERS.includes(provider)) {
    container.classList.remove('voice-unmapped');
    const note = document.createElement('span');
    note.className = 'voice-note';
    note.textContent = 'Auto-assigned';
    container.appendChild(note);
    return;
  }

  const select = document.createElement('select');
  select.disabled = Boolean(uiStore.get().operation);
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
  container.classList.toggle('voice-unmapped', !narratorVoice?.voiceId);

  const previewBtn = document.createElement('button');
  previewBtn.type = 'button';
  previewBtn.className = 'secondary text-button voice-preview-btn';
  previewBtn.textContent = '▶';
  previewBtn.title = 'Preview voice';
  previewBtn.setAttribute('aria-label', 'Preview selected voice');
  previewBtn.disabled = !select.value || select.value === 'clone';
  previewBtn.addEventListener('click', () => {
    const chosen = availableVoices.find((voice) => voice.voiceId === select.value);
    previewVoice(
      provider,
      chosen,
      (msg) => { if (els.statusText) els.statusText.textContent = msg; },
      () => {
        previewBtn.textContent = '■';
        previewBtn.title = 'Stop preview';
      },
      () => {
        previewBtn.textContent = '▶';
        previewBtn.title = 'Preview voice';
      }
    );
  });

  select.addEventListener('change', () => {
    stopPreviewVoice();
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

    container.classList.toggle('voice-unmapped', !voiceStore.get().narratorVoice[provider]?.voiceId);
    const record = getCurrentStoryboardRecord();
    if (record) {
      record.narratorVoice = voiceStore.get().narratorVoice;
      queueSync(record);
    }
  });

  container.append(select, previewBtn);
}

export function renderVoicesPanel(els) {
  renderVoicePicker(els, els.voicesPanel);
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
  const downloading = uiStore.get().operation?.type === 'downloadZip';
  els.generationSummaryText.classList.toggle('is-loading', downloading);
  els.generationSummaryText.setAttribute('aria-busy', String(downloading));
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
  const busy = Boolean(uiState.operation);

  const status = computeStageStatus(sceneState.scenes, batchState, uiState.operation, getCachedJobs(), record?.stageRuns || {});
  const spend = getCachedSpend();

  if (els.stagePlanningStatus) els.stagePlanningStatus.textContent = stageStatusLabel(status.planning);
  if (els.stageImagesStatus) els.stageImagesStatus.textContent = stageStatusLabel(status.images);
  if (els.stageAudioStatus) els.stageAudioStatus.textContent = stageStatusLabel(status.audio);
  if (els.stageVideoStatus) els.stageVideoStatus.textContent = stageStatusLabel(status.video);
  if (els.stageSubtitlesStatus) els.stageSubtitlesStatus.textContent = stageStatusLabel(status.subtitles);
  if (els.stageTokensStatus) {
    els.stageTokensStatus.textContent = spend.totalCredits != null ? `${spend.totalCredits.toFixed(2)} credits` : '0.00 credits';
  }

  if (els.stageTokensBtn) {
    els.stageTokensBtn.disabled = true;
    const providerLines = Object.entries(spend.providers || {})
      .map(([provider, stats]) => `${provider}: $${stats.costUSD.toFixed(4)} (${stats.tokens.toLocaleString()} tokens)`)
      .join('\n');
    els.stageTokensBtn.title = [`${(spend.totalCostUSD || 0).toFixed(4)} USD`, providerLines].filter(Boolean).join('\n') || 'No spend recorded';
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

  renderGenerationSummary(els, status);
}

export function initImageLibraryModal(domEls, setStatus) {
  initImageLibraryController(domEls, setStatus, { renderStyleReferences });
}

export function openImageLibrary(options) {
  return openImageLibraryController(options);
}

export function populateTokensInfoModal(els) {
  renderTokenDetails(els, getCachedSpend() || {});
}
