import { projectStore, sceneStore, generationStore, voiceStore, uiStore, batchStore } from './store.js';
import { getCurrentStoryboardRecord, persistStoryboardLibrary, queueSync } from './persistence.js';
import { loadProtectedAsset } from './assets.js';
import { api } from './api.js';
import { getSpeakersFromScenes } from './workflows.js';

const NO_MAPPING_AUDIO_PROVIDERS = ['stub', 'piper'];

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
  if (els.storyboardTitle) els.storyboardTitle.value = current?.title || 'Untitled storyboard';
  els.storyboardPicker.replaceChildren();
  state.storyboards
    .slice()
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .forEach((storyboard) => {
      const option = document.createElement('option');
      option.value = storyboard.id;
      option.textContent = storyboard.title;
      els.storyboardPicker.appendChild(option);
    });
  els.storyboardPicker.value = state.currentId;
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
  if (!els.styleReferencesDetails.open) {
    els.characterRefs.replaceChildren();
    els.worldRefs.replaceChildren();
    return;
  }
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
  els.styleReferencesDetails.setAttribute('aria-busy', 'true');
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
    if (els.styleSelect.value === styleId) els.styleReferencesDetails.removeAttribute('aria-busy');
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
  const speakers = getSpeakersFromScenes();
  const state = voiceStore.get();
  const provider = state.audioProvider;
  const voiceMap = state.voiceMap[provider] || {};
  const availableVoices = ['elevenlabs', 'spark'].includes(provider) ? (state.availableVoices[provider] || []) : [];
  
  els.voiceCloningBtn.hidden = provider !== 'spark';
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
      select.disabled = uiStore.get().operation != null;
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
        
        voiceStore.set(s => {
          const map = { ...s.voiceMap[provider] };
          if (chosen) map[speaker] = { voiceId: chosen.voiceId, label: chosen.label };
          else delete map[speaker];
          return { voiceMap: { ...s.voiceMap, [provider]: map } };
        });
        
        row.classList.toggle('voice-unmapped', !voiceStore.get().voiceMap[provider]?.[speaker]?.voiceId);
        const record = getCurrentStoryboardRecord();
        if (record) {
          record.voiceMap = voiceStore.get().voiceMap;
          queueSync(record);
        }
      });
      row.appendChild(select);
    }
    els.voicesPanel.appendChild(row);
  });
}

export function updateButtons(els) {
  const uiState = uiStore.get();
  const sceneState = sceneStore.get();
  const batchState = batchStore.get();
  
  const busy = uiState.operation != null;
  const promptsCanBeGenerated = !sceneState.scenes.length || 
    !(sceneState.lastPromptInputs && 
      sceneState.lastPromptInputs.scriptText === els.scriptText.value &&
      sceneState.lastPromptInputs.commonPromptText === els.commonPromptText.value);

  els.generatePromptsBtn.disabled = busy || !promptsCanBeGenerated;
  els.generatePromptsBtn.textContent = 'Generate prompts';
  els.newStoryboardBtn.disabled = busy;
  els.storyboardPicker.disabled = busy;
  els.saveStateBtn.disabled = busy || els.saveStateBtn.textContent !== 'Retry save';
  els.downloadZipBtn.disabled = busy || !sceneState.scenes.some((scene) => scene.versions.length);
  els.characterRefInput.disabled = busy;
  els.worldRefInput.disabled = busy;
  els.audioProvider.disabled = busy;
  els.generateDialogueBtn.disabled = busy || !sceneState.scenes.length;
  els.generateDialogueBtn.textContent = sceneState.scenes.some((scene) => scene.lines.length) ? 'Regenerate dialogue' : 'Generate dialogue';

  configureBatchButton(els.startSerialBtn, {
    noun: 'images',
    generating: batchState.images.generating,
    stopRequested: batchState.images.stopRequested,
    serialState: batchState.images.state,
    canStart: sceneState.scenes.length > 0,
    busy
  });
  
  configureBatchButton(els.startAudioSerialBtn, {
    noun: 'audio',
    generating: batchState.audio.generating,
    stopRequested: batchState.audio.stopRequested,
    serialState: batchState.audio.state,
    canStart: sceneState.scenes.some((scene) => scene.lines.length),
    busy
  });

  configureBatchButton(els.startVideoSerialBtn, {
    noun: 'videos',
    generating: batchState.videos?.generating,
    stopRequested: batchState.videos?.stopRequested,
    serialState: batchState.videos?.state,
    canStart: sceneState.scenes.some((scene) => scene.versions.length),
    busy
  });

  document.querySelectorAll('.ref-delete-btn, .version-thumb, .audio-version-select:not(.is-current)').forEach((button) => { button.disabled = busy; });
  
  if (uiState.operation?.type === 'prompts') {
    els.generatePromptsBtn.classList.add('is-loading');
    els.generatePromptsBtn.setAttribute('aria-busy', 'true');
  } else {
    els.generatePromptsBtn.classList.remove('is-loading');
    els.generatePromptsBtn.setAttribute('aria-busy', 'false');
  }
}

function configureBatchButton(button, { noun, generating, stopRequested, serialState, canStart, busy }) {
  if (!button) return;
  button.classList.remove('primary', 'secondary', 'danger');
  button.setAttribute('aria-busy', String(generating));
  if (generating) {
    button.textContent = stopRequested ? 'Stopping…' : `Stop ${noun}`;
    button.classList.add('danger');
    button.disabled = stopRequested;
    return;
  }

  if (serialState === 'paused') button.textContent = `Resume ${noun}`;
  else if (serialState === 'failed') button.textContent = `Retry ${noun}`;
  else if (serialState === 'complete') button.textContent = `Regenerate ${noun}`;
  else button.textContent = `Generate ${noun}`;
  
  button.classList.add(['paused', 'failed'].includes(serialState) ? 'primary' : 'secondary');
  button.disabled = busy || !canStart;
}
