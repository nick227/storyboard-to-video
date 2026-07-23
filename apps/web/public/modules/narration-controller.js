import { sceneStore, uiStore, voiceStore } from './store.js';
import { getCurrentStoryboardRecord, queueSync } from './persistence.js';
import { computeStaleness } from './stages.js';
import { loadProtectedAsset } from './assets.js';
import {
  prepareNarration,
  regenerateAudio,
  regenerateDialogue,
  splitSceneInPlace,
} from './workflows.js';

const WORDS_PER_MINUTE = 150;

function hasNarrationChanges(record, elements) {
  const last = record?.lastNarrationInputs;
  if (!sceneStore.get().scenes.length) return Boolean(elements.scriptText.value.trim());
  if (!last) return false; // Legacy planned projects remain usable until explicitly re-prepared.
  return String(last.scriptText || '').trim() !== String(elements.scriptText.value || '').trim()
    || String(last.textProvider || '') !== String(elements.textProvider.value || '')
    || Boolean(last.enrich) !== Boolean(elements.enrichNarration.checked)
    || String(last.guidance || '') !== String(elements.guidance.value || '').trim();
}

function estimatedSeconds(text) {
  const words = String(text || '').match(/\S+/g)?.length || 0;
  return Math.max(0, Math.round((words / WORDS_PER_MINUTE) * 60));
}

function durationLabel(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function persistScenes(scenes, setStatus) {
  sceneStore.set({ scenes });
  const record = getCurrentStoryboardRecord();
  if (!record) return;
  record.scenes = scenes;
  queueSync(record, setStatus);
}

function appendGuidance(current, helper) {
  const value = String(current || '').trim();
  return value ? `${value} ${helper}` : helper;
}

export function initNarrationController(elements, services = {}) {
  const editTimers = new Map();
  const setStatus = services.setStatus || (() => {});
  let skipNextSceneRender = false;

  const syncControls = () => {
    elements.mode.value = elements.enrichNarration.checked ? 'enriched' : 'literal';
    elements.textProviderMirror.value = elements.textProvider.value;
    elements.audioProviderMirror.value = voiceStore.get().audioProvider;
    const record = getCurrentStoryboardRecord();
    if (document.activeElement !== elements.guidance) elements.guidance.value = record?.narrationGuidance || '';
  };

  const saveNarrationSettings = () => {
    const record = getCurrentStoryboardRecord();
    if (!record) return;
    record.narrationGuidance = elements.guidance.value.trim();
    services.saveProject?.(false);
  };

  const updateNarrationText = (sceneId, value) => {
    const scenes = sceneStore.get().scenes.map((scene) => scene.id === sceneId
      ? { ...scene, narrationText: value, narrationIsFallback: false }
      : scene);
    skipNextSceneRender = true;
    sceneStore.set({ scenes });
    clearTimeout(editTimers.get(sceneId));
    editTimers.set(sceneId, setTimeout(() => {
      const record = getCurrentStoryboardRecord();
      if (record) {
        record.scenes = sceneStore.get().scenes;
        queueSync(record, setStatus);
      }
      editTimers.delete(sceneId);
    }, 300));
  };

  const mergeWithNext = (index) => {
    const scenes = sceneStore.get().scenes;
    if (!scenes[index] || !scenes[index + 1]) return;
    if (!window.confirm(`Merge scenes ${index + 1} and ${index + 2}? Existing media is retained as archived version history and will be stale for the merged narration.`)) return;
    const first = scenes[index];
    const second = scenes[index + 1];
    const merged = {
      ...first,
      sourceScriptFragment: [first.sourceScriptFragment || first.scriptFragment, second.sourceScriptFragment || second.scriptFragment].filter(Boolean).join('\n\n'),
      scriptFragment: [first.sourceScriptFragment || first.scriptFragment, second.sourceScriptFragment || second.scriptFragment].filter(Boolean).join('\n\n'),
      narrationText: [first.narrationText, second.narrationText].filter(Boolean).join('\n\n'),
      narrationIsFallback: Boolean(first.narrationIsFallback || second.narrationIsFallback),
      archivedMergedScenes: [...(first.archivedMergedScenes || []), second],
    };
    const next = [...scenes.slice(0, index), merged, ...scenes.slice(index + 2)]
      .map((scene, sceneIndex) => ({ ...scene, sceneNumber: sceneIndex + 1, title: `Scene ${sceneIndex + 1}` }));
    persistScenes(next, setStatus);
    setStatus(`Merged scenes ${index + 1} and ${index + 2}. Visuals and audio should be regenerated.`);
  };

  const render = () => {
    syncControls();
    const scenes = sceneStore.get().scenes;
    const operation = uiStore.get().operation;
    const record = getCurrentStoryboardRecord();
    const totalSeconds = scenes.reduce((sum, scene) => sum + estimatedSeconds(scene.narrationText), 0);
    elements.sceneCount.textContent = `${scenes.length} scene${scenes.length === 1 ? '' : 's'}`;
    elements.totalDuration.textContent = `About ${durationLabel(totalSeconds)}`;
    elements.staleNotice.hidden = !hasNarrationChanges(record, {
      ...elements,
      textProvider: elements.textProvider,
      enrichNarration: elements.enrichNarration,
    });
    elements.empty.hidden = scenes.length > 0;
    elements.rows.hidden = scenes.length === 0;
    elements.prepareBtn.disabled = Boolean(operation) || !elements.scriptText.value.trim();
    elements.prepareBtn.textContent = scenes.length ? 'Regenerate narration' : 'Prepare narration';

    const nodes = scenes.map((scene, index) => {
      const row = document.createElement('article');
      row.className = 'narration-row';
      row.dataset.sceneId = scene.id;

      const header = document.createElement('div');
      header.className = 'narration-row-header';
      const heading = document.createElement('div');
      heading.className = 'narration-row-heading';
      const sceneNumber = document.createElement('span');
      sceneNumber.className = 'narration-row-number';
      sceneNumber.textContent = String(index + 1);
      const title = document.createElement('strong');
      title.textContent = scene.title || `Scene ${index + 1}`;
      heading.append(sceneNumber, title);

      const statuses = document.createElement('div');
      statuses.className = 'narration-row-statuses';
      const freshness = computeStaleness(scene);
      const activeAudio = scene.audioVersions?.[scene.activeAudioVersionIndex];
      const audioState = !activeAudio?.path ? 'Missing audio' : freshness.audioStale ? 'Audio stale' : 'Audio ready';
      const audioBadge = document.createElement('span');
      audioBadge.className = `narration-status ${!activeAudio?.path ? 'is-missing' : freshness.audioStale ? 'is-stale' : 'is-ready'}`;
      audioBadge.textContent = audioState;
      const visualBadge = document.createElement('span');
      visualBadge.className = `narration-status ${!scene.prompt ? 'is-missing' : freshness.promptStale ? 'is-stale' : 'is-ready'}`;
      visualBadge.textContent = !scene.prompt ? 'Visuals not planned' : freshness.promptStale ? 'Visuals stale' : 'Storyboard ready';
      statuses.append(audioBadge, visualBadge);
      header.append(heading, statuses);

      const body = document.createElement('div');
      body.className = 'narration-row-body';
      const source = document.createElement('details');
      source.className = 'narration-source';
      const sourceSummary = document.createElement('summary');
      sourceSummary.textContent = 'Source excerpt';
      const sourceText = document.createElement('p');
      sourceText.textContent = scene.sourceScriptFragment || scene.scriptFragment || 'No source excerpt recorded.';
      source.append(sourceSummary, sourceText);

      const editor = document.createElement('div');
      editor.className = 'narration-editor';
      const textarea = document.createElement('textarea');
      textarea.value = scene.narrationText || '';
      textarea.rows = 4;
      textarea.disabled = Boolean(operation);
      textarea.setAttribute('aria-label', `Narration for scene ${index + 1}`);
      const meta = document.createElement('small');
      const updateMeta = () => {
        const words = textarea.value.match(/\S+/g)?.length || 0;
        meta.textContent = `${words} word${words === 1 ? '' : 's'} · about ${durationLabel(estimatedSeconds(textarea.value))}`;
      };
      updateMeta();
      textarea.addEventListener('input', () => {
        updateMeta();
        updateNarrationText(scene.id, textarea.value);
      });
      textarea.addEventListener('blur', render, { once: true });
      editor.append(textarea, meta);

      const actions = document.createElement('div');
      actions.className = 'narration-row-actions';
      const instruction = document.createElement('input');
      instruction.type = 'text';
      instruction.maxLength = 500;
      instruction.placeholder = 'Optional rewrite instruction';
      instruction.setAttribute('aria-label', `Rewrite instruction for scene ${index + 1}`);
      instruction.disabled = Boolean(operation);
      const regenerate = document.createElement('button');
      regenerate.type = 'button';
      regenerate.className = 'secondary';
      regenerate.textContent = 'Regenerate';
      regenerate.disabled = Boolean(operation);
      regenerate.addEventListener('click', () => regenerateDialogue(index, elements.appElements, setStatus, instruction.value.trim()));
      const split = document.createElement('button');
      split.type = 'button';
      split.className = 'secondary';
      split.textContent = 'Split';
      split.disabled = Boolean(operation);
      split.addEventListener('click', () => splitSceneInPlace(index, 2, elements.appElements, setStatus));
      const merge = document.createElement('button');
      merge.type = 'button';
      merge.className = 'secondary';
      merge.textContent = 'Merge next';
      merge.disabled = Boolean(operation) || index === scenes.length - 1;
      merge.addEventListener('click', () => mergeWithNext(index));
      const generateAudio = document.createElement('button');
      generateAudio.type = 'button';
      generateAudio.className = 'primary';
      generateAudio.textContent = activeAudio?.path ? 'Regenerate voice' : 'Generate voice';
      generateAudio.disabled = Boolean(operation) || !scene.narrationText?.trim() || scene.narrationIsFallback;
      generateAudio.addEventListener('click', () => regenerateAudio(index, null, elements.appElements, setStatus));
      actions.append(instruction, regenerate, split, merge, generateAudio);

      if (activeAudio?.path) {
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.preload = 'metadata';
        audio.className = 'narration-row-audio';
        loadProtectedAsset(activeAudio.path).then((url) => {
          if (url && row.isConnected) audio.src = url;
        }).catch(() => {});
        actions.append(audio);
      }

      body.append(source, editor, actions);
      row.append(header, body);
      return row;
    });
    elements.rows.replaceChildren(...nodes);
  };

  elements.prepareBtn.addEventListener('click', async () => {
    if (sceneStore.get().scenes.length
      && !window.confirm('Regenerate narration and scene boundaries from the current script? Existing generated media will remain in storage, but the current scene structure will be replaced.')) return;
    await prepareNarration(elements.appElements, setStatus);
  });
  elements.mode.addEventListener('change', () => {
    elements.enrichNarration.checked = elements.mode.value === 'enriched';
    elements.enrichNarration.dispatchEvent(new Event('change', { bubbles: true }));
    render();
  });
  elements.textProviderMirror.addEventListener('change', () => {
    elements.textProvider.value = elements.textProviderMirror.value;
    elements.textProvider.dispatchEvent(new Event('change', { bubbles: true }));
    render();
  });
  elements.audioProviderMirror.addEventListener('change', () => {
    elements.audioProvider.value = elements.audioProviderMirror.value;
    elements.audioProvider.dispatchEvent(new Event('change', { bubbles: true }));
    render();
  });
  elements.guidance.addEventListener('input', saveNarrationSettings);
  elements.helperButtons.forEach((button) => button.addEventListener('click', () => {
    elements.guidance.value = appendGuidance(elements.guidance.value, button.dataset.narrationHelper);
    saveNarrationSettings();
    elements.guidance.focus();
    render();
  }));

  sceneStore.subscribe(() => {
    if (skipNextSceneRender) {
      skipNextSceneRender = false;
      return;
    }
    render();
  });
  uiStore.subscribe(render);
  voiceStore.subscribe(() => {
    syncControls();
    services.renderVoices?.();
    render();
  });
  render();
  return { render };
}
