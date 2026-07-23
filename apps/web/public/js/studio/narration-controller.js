import { sceneStore, uiStore, voiceStore } from '../core/store.js';
import { getCurrentStoryboardRecord, queueSync } from '../core/persistence.js';
import { api } from '../core/api.js';
import { adaptSceneImageShot } from '../core/scene-shots.js';
import { getArchivedNarrationPlans, insertBlankSceneAt, restoreArchivedNarrationPlan } from '../generation/workflows.js';

function narrationModeKey(enrich) {
  return enrich ? 'enriched' : 'literal';
}

function customNarrationPrompt(record, enrich) {
  return String(record?.narrationPromptOverrides?.[narrationModeKey(enrich)] || '').trim();
}

function persistScenes(scenes, setStatus) {
  sceneStore.set({ scenes });
  const record = getCurrentStoryboardRecord();
  if (!record) return;
  record.scenes = scenes;
  queueSync(record, setStatus);
}

function mediaCount(scenes) {
  return (scenes || []).reduce((count, scene) => count
    + (scene.audioVersions?.length || 0)
    + (scene.subtitleVersions?.length || 0)
    + (scene.versions?.length || scene.shots?.[0]?.versions?.length || 0)
    + (scene.videoVersions?.length || scene.shots?.[0]?.videoVersions?.length || 0), 0);
}

function renumber(scenes) {
  return scenes.map((scene, index) => adaptSceneImageShot({
    ...scene,
    sceneNumber: index + 1,
    title: !scene.title || /^Scene \d+$/.test(scene.title) ? `Scene ${index + 1}` : scene.title,
  }));
}

export function initNarrationController(elements, services = {}) {
  const setStatus = services.setStatus || (() => {});
  let narrationPromptDefaults = { literal: '', enriched: '' };

  const syncControls = () => {
    elements.mode.value = elements.enrichNarration.checked ? 'enriched' : 'literal';
    const record = getCurrentStoryboardRecord();
    if (document.activeElement !== elements.guidance) elements.guidance.value = record?.narrationGuidance || '';
    const modeKey = narrationModeKey(elements.enrichNarration.checked);
    const customPrompt = customNarrationPrompt(record, elements.enrichNarration.checked);
    if (document.activeElement !== elements.promptText) {
      elements.promptText.value = customPrompt || narrationPromptDefaults[modeKey] || '';
    }
    elements.promptReset.disabled = !customPrompt;

  };

  const saveNarrationSettings = () => {
    const record = getCurrentStoryboardRecord();
    if (!record) return;
    record.narrationGuidance = elements.guidance.value.trim();
    services.saveProject?.(false);
  };

  const saveNarrationPrompt = () => {
    const record = getCurrentStoryboardRecord();
    if (!record) return;
    const modeKey = narrationModeKey(elements.enrichNarration.checked);
    const value = elements.promptText.value.trim();
    record.narrationPromptOverrides = { ...(record.narrationPromptOverrides || {}) };
    if (value && value !== narrationPromptDefaults[modeKey]) record.narrationPromptOverrides[modeKey] = value;
    else delete record.narrationPromptOverrides[modeKey];
    elements.promptReset.disabled = !record.narrationPromptOverrides[modeKey];
    services.saveProject?.(false);
  };

  const deleteScene = (sceneId) => {
    const scenes = sceneStore.get().scenes;
    const index = scenes.findIndex((scene) => scene.id === sceneId);
    const scene = scenes[index];
    if (!scene) return;
    const versions = mediaCount([scene]);
    const excerpt = String(scene.narrationText || scene.sourceScriptFragment || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    const description = excerpt ? `“${excerpt}${excerpt.length === 140 ? '…' : ''}”` : 'This scene is currently empty.';
    if (!window.confirm(`Delete scene ${index + 1} from the story?\n\n${description}\n\nThis removes it from Narration, Storyboard, and Timeline. ${versions} generated media version(s) will be archived, not deleted. Neighboring visual plans will be marked stale for continuity review. It can be restored later from Narration history.`)) return;
    const record = getCurrentStoryboardRecord();
    if (record) {
      record.archivedDeletedScenes = [{
        id: crypto.randomUUID(),
        deletedAt: new Date().toISOString(),
        originalIndex: index,
        scene: structuredClone(scene),
      }, ...(record.archivedDeletedScenes || [])].slice(0, 20);
      record.structureReviewRecommended = true;
      record.structureEditedAt = new Date().toISOString();
    }
    const retained = scenes.filter((candidate) => candidate.id !== sceneId).map((candidate, retainedIndex, all) => {
      const wasAdjacent = retainedIndex === Math.max(0, index - 1) || retainedIndex === Math.min(index, all.length - 1);
      return wasAdjacent ? { ...candidate, structuralContextStale: true } : candidate;
    });
    const nextScenes = renumber(retained);
    persistScenes(nextScenes, setStatus);
    uiStore.set({ selectedSceneId: nextScenes[Math.min(index, nextScenes.length - 1)]?.id || null });
    setStatus(`Deleted scene ${index + 1}. Its media is archived; review the neighboring scenes for story continuity or restore it from Narration history.`);
  };

  const restoreDeletedScene = (archiveId) => {
    const record = getCurrentStoryboardRecord();
    const archived = record?.archivedDeletedScenes || [];
    const entry = archived.find((item) => item.id === archiveId);
    if (!record || !entry?.scene) return;
    record.archivedDeletedScenes = archived.filter((item) => item.id !== archiveId);
    record.structureReviewRecommended = true;
    record.structureEditedAt = new Date().toISOString();
    const scenes = [...sceneStore.get().scenes];
    const insertAt = Math.min(Math.max(Number(entry.originalIndex) || 0, 0), scenes.length);
    scenes.splice(insertAt, 0, { ...structuredClone(entry.scene), structuralContextStale: true });
    const withStaleNeighbors = scenes.map((scene, index) =>
      Math.abs(index - insertAt) <= 1 ? { ...scene, structuralContextStale: true } : scene);
    const nextScenes = renumber(withStaleNeighbors);
    persistScenes(nextScenes, setStatus);
    uiStore.set({ selectedSceneId: nextScenes[insertAt]?.id || null });
    setStatus(`Restored the deleted scene at position ${insertAt + 1}. Review it and its neighbors for continuity.`);
  };

  const openAddSceneDialog = () => {
    const scenes = sceneStore.get().scenes;
    if (scenes.length >= 200) {
      setStatus('This project already has the maximum of 200 scenes.');
      return;
    }
    const selectedIndex = scenes.findIndex((scene) => scene.id === uiStore.get().selectedSceneId);
    const defaultInsertAt = selectedIndex >= 0 ? selectedIndex + 1 : scenes.length;
    const options = Array.from({ length: scenes.length + 1 }, (_, insertAt) => {
      const option = document.createElement('option');
      option.value = String(insertAt);
      option.textContent = insertAt === 0
        ? 'At beginning'
        : insertAt === scenes.length ? 'At end' : `After scene ${insertAt}`;
      return option;
    });
    elements.addScenePosition.replaceChildren(...options);
    elements.addScenePosition.value = String(defaultInsertAt);
    if (typeof elements.addSceneDialog.showModal === 'function') elements.addSceneDialog.showModal();
  };

  const addBlankScene = () => {
    if (uiStore.get().operation) return;
    const { scenes, insertedScene, insertAt } = insertBlankSceneAt(
      sceneStore.get().scenes,
      elements.addScenePosition.value,
    );
    const record = getCurrentStoryboardRecord();
    if (record) {
      record.structureReviewRecommended = true;
      record.structureEditedAt = new Date().toISOString();
    }
    persistScenes(scenes, setStatus);
    uiStore.set({ selectedSceneId: insertedScene.id });
    elements.addSceneDialog.close();
    setStatus(`Added empty scene ${insertAt + 1}. Add narration or a visual prompt when you are ready; generation stays blocked until its required input exists.`);
  };

  const renderHistory = () => {
    const plans = getArchivedNarrationPlans();
    const deletedScenes = getCurrentStoryboardRecord()?.archivedDeletedScenes || [];
    const historyCount = plans.length + deletedScenes.length;
    elements.historyToggle.textContent = `Narration history${historyCount ? ` (${historyCount})` : ''}`;
    if (!historyCount) {
      const empty = document.createElement('p');
      empty.className = 'narration-history-empty';
      empty.textContent = 'No earlier narration plans have been archived yet.';
      elements.historyList.replaceChildren(empty);
      return;
    }
    const planNodes = plans.map((plan) => {
      const item = document.createElement('div');
      item.className = 'narration-history-item';
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      const date = Number.isNaN(new Date(plan.createdAt).getTime()) ? '' : new Date(plan.createdAt).toLocaleString();
      summary.textContent = `${plan.label || 'Narration plan'} · ${plan.scenes.length} scenes${date ? ` · ${date}` : ''}`;
      const comparison = document.createElement('p');
      const currentScenes = sceneStore.get().scenes;
      const currentContent = new Set(currentScenes.map((scene) =>
        `${String(scene.sourceScriptFragment || '').trim()}\u0000${String(scene.narrationText || '').trim()}`));
      const exactOverlap = plan.scenes.filter((scene) =>
        currentContent.has(`${String(scene.sourceScriptFragment || '').trim()}\u0000${String(scene.narrationText || '').trim()}`)).length;
      const delta = plan.scenes.length - currentScenes.length;
      comparison.textContent = `${delta >= 0 ? '+' : ''}${delta} scenes versus current · ${exactOverlap} exact scene${exactOverlap === 1 ? '' : 's'} overlap · ${mediaCount(plan.scenes)} preserved media versions`;
      details.append(summary, comparison);
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'secondary';
      restore.textContent = 'Restore';
      restore.addEventListener('click', () => {
        if (!window.confirm(`Restore this ${plan.scenes.length}-scene narration plan? The current plan will be archived and no generated media will be deleted.`)) return;
        restoreArchivedNarrationPlan(plan.id, setStatus);
      });
      item.append(details, restore);
      return item;
    });
    const deletedNodes = deletedScenes.map((entry) => {
      const item = document.createElement('div');
      item.className = 'narration-history-item';
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = `Deleted scene · formerly ${Number(entry.originalIndex) + 1} · ${new Date(entry.deletedAt).toLocaleString()}`;
      const comparison = document.createElement('p');
      const excerpt = String(entry.scene?.narrationText || entry.scene?.sourceScriptFragment || '').replace(/\s+/g, ' ').trim().slice(0, 180);
      comparison.textContent = `${excerpt}${excerpt.length === 180 ? '…' : ''} · ${mediaCount([entry.scene])} preserved media versions`;
      details.append(summary, comparison);
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'secondary';
      restore.textContent = 'Restore scene';
      restore.addEventListener('click', () => restoreDeletedScene(entry.id));
      item.append(details, restore);
      return item;
    });
    elements.historyList.replaceChildren(...planNodes, ...deletedNodes);
  };

  const render = () => {
    syncControls();
    const scenes = sceneStore.get().scenes;
    const operation = uiStore.get().operation;
    elements.addSceneBtn.disabled = Boolean(operation) || scenes.length >= 200;
    elements.addSceneConfirm.disabled = Boolean(operation) || scenes.length >= 200;
    renderHistory();
  };

  elements.addSceneBtn.addEventListener('click', () => openAddSceneDialog());
  elements.addSceneCancel.addEventListener('click', () => elements.addSceneDialog.close());
  elements.addSceneConfirm.addEventListener('click', addBlankScene);
  window.addEventListener('storyboard:delete-scene', (event) => {
    if (event.detail?.sceneId) deleteScene(event.detail.sceneId);
  });
  elements.historyToggle.addEventListener('click', () => {
    elements.historyPanel.hidden = !elements.historyPanel.hidden;
    elements.historyToggle.setAttribute('aria-expanded', String(!elements.historyPanel.hidden));
  });
  elements.mode.addEventListener('change', () => {
    elements.enrichNarration.checked = elements.mode.value === 'enriched';
    elements.enrichNarration.dispatchEvent(new Event('change', { bubbles: true }));
    render();
  });
  elements.guidance.addEventListener('input', saveNarrationSettings);
  elements.promptText.addEventListener('input', saveNarrationPrompt);
  elements.promptReset.addEventListener('click', () => {
    const record = getCurrentStoryboardRecord();
    if (!record) return;
    const modeKey = narrationModeKey(elements.enrichNarration.checked);
    record.narrationPromptOverrides = { ...(record.narrationPromptOverrides || {}) };
    delete record.narrationPromptOverrides[modeKey];
    elements.promptText.value = narrationPromptDefaults[modeKey] || '';
    services.saveProject?.(false);
    render();
  });
  sceneStore.subscribe(render);
  uiStore.subscribe(render);
  voiceStore.subscribe(() => {
    services.renderVoices?.();
    render();
  });
  render();
  api('/api/storyboard/narration-prompts').then((data) => {
    narrationPromptDefaults = {
      literal: String(data?.prompts?.literal || ''),
      enriched: String(data?.prompts?.enriched || ''),
    };
    render();
  }).catch((error) => {
    render();
    setStatus(`Narration prompt defaults could not be loaded: ${error.message}`);
  });
  return { render };
}
