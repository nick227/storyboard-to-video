import { api, logicalIdempotencyKey } from '../core/api.js';
import { batchStore, projectStore, sceneStore, voiceStore, generationStore, uiStore } from '../core/store.js';
import { getCurrentStoryboardRecord, queueSync, ensureProjectSynced, hydrateCurrentProjectFromServer } from '../core/persistence.js';
import { clampSplitCount } from './scene-count.js';
import { adaptSceneImageShot, imageShot, replaceImageState, replaceVideoState, setImagePrompt } from '../core/scene-shots.js';
import { textValue } from '../core/text-values.js';

export function getPayloadBase(els) {
  return {
    projectId: projectStore.get().currentId,
    scriptText: els.scriptText.value,
    styleId: els.styleSelect.value,
    commonPromptText: els.commonPromptText.value,
    textProvider: els.textProvider.value,
    imageProvider: els.imageProvider.value,
    fallbackPolicy: els.fallbackPolicy.value,
    enrich: els.enrichNarration ? els.enrichNarration.checked : false,
  };
}

export function normalizeScene(scene, index) {
  const projectPrefix = `/projects/${encodeURIComponent(projectStore.get().currentId || '')}/assets/`;
  const sourceShot = imageShot(scene);
  const versions = Array.isArray(sourceShot.versions)
    ? sourceShot.versions.filter((version) => typeof version?.path === 'string' && (version.path.startsWith(`${projectPrefix}images/`) || version.path.startsWith('/generated/')))
    : [];
  const requestedIndex = Number.isInteger(sourceShot.activeVersionIndex) ? sourceShot.activeVersionIndex : 0;
  // Server-authoritative normalization (project-store.js) is what actually adapts legacy `lines`
  // into `narrationText`. This is only a trivial client-side fallback for stale local-cached data
  // that hasn't round-tripped through the server yet — not a reimplementation of that adapter.
  const narrationText = textValue(scene?.narrationText, ['narrationText']);
  const narrationIsFallback = Boolean(scene?.narrationIsFallback);
  const audioVersions = Array.isArray(scene?.audioVersions)
    ? scene.audioVersions.filter((version) => typeof version?.path === 'string' && (version.path.startsWith(`${projectPrefix}audio/`) || version.path.startsWith('/audio/')))
    : [];
  const requestedAudioIndex = Number.isInteger(scene?.activeAudioVersionIndex) ? scene.activeAudioVersionIndex : 0;
  
  const videoVersions = Array.isArray(sourceShot.videoVersions)
    ? sourceShot.videoVersions.filter((version) => typeof version?.path === 'string' && (version.path.startsWith(`${projectPrefix}videos/`) || version.path.startsWith('/videos/')))
    : [];
  const requestedVideoIndex = Number.isInteger(sourceShot.activeVideoVersionIndex) ? sourceShot.activeVideoVersionIndex : (videoVersions.length ? videoVersions.length - 1 : 0);

  const subtitleVersions = Array.isArray(scene?.subtitleVersions)
    ? scene.subtitleVersions.filter((version) => typeof version?.path === 'string' && version.path.startsWith(`${projectPrefix}subtitles/`))
    : [];
  const requestedSubtitleIndex = Number.isInteger(scene?.activeSubtitleVersionIndex) ? scene.activeSubtitleVersionIndex : 0;

  let activeVisualType = scene?.activeVisualType === 'image' || scene?.activeVisualType === 'video'
    ? scene.activeVisualType
    : (videoVersions.length ? 'video' : 'image');
  if (activeVisualType === 'video' && !videoVersions.length) activeVisualType = 'image';
  if (activeVisualType === 'image' && !versions.length && videoVersions.length) activeVisualType = 'video';
  
  return adaptSceneImageShot({
    id: typeof scene?.id === 'string' ? scene.id : crypto.randomUUID(),
    title: String(scene?.title || `Scene ${index + 1}`),
    beat: String(scene?.beat || ''),
    shots: [{
      ...sourceShot,
      prompt: textValue(sourceShot.prompt, ['prompt']),
      versions,
      activeVersionIndex: versions.length ? Math.min(Math.max(requestedIndex, 0), versions.length - 1) : 0,
      videoVersions,
      activeVideoVersionIndex: videoVersions.length ? Math.min(Math.max(requestedVideoIndex, 0), videoVersions.length - 1) : 0,
    }, ...(Array.isArray(scene?.shots) ? scene.shots.slice(1) : [])],
    scriptFragment: typeof scene?.scriptFragment === 'string' ? scene.scriptFragment : '',
    sourceScriptFragment: typeof scene?.sourceScriptFragment === 'string'
      ? scene.sourceScriptFragment
      : (typeof scene?.scriptFragment === 'string' ? scene.scriptFragment : ''),
    ...(Number.isInteger(scene?.sourceStart) ? { sourceStart: scene.sourceStart } : {}),
    ...(Number.isInteger(scene?.sourceEnd) ? { sourceEnd: scene.sourceEnd } : {}),
    ...(typeof scene?.sourceMappingMethod === 'string' ? { sourceMappingMethod: scene.sourceMappingMethod } : {}),
    // Both stamped server-side (prompt-generation.service.js), from what generation actually used as
    // source — never computed here from local state, so staleness survives reloads/concurrent tabs.
    promptGeneratedFromBeat: typeof scene?.promptGeneratedFromBeat === 'string' ? scene.promptGeneratedFromBeat : '',
    promptGeneratedFromNarration: typeof scene?.promptGeneratedFromNarration === 'string' ? scene.promptGeneratedFromNarration : null,
    narrationText,
    narrationIsFallback,
    audioVersions,
    activeAudioVersionIndex: audioVersions.length ? Math.min(Math.max(requestedAudioIndex, 0), audioVersions.length - 1) : 0,
    subtitleVersions,
    activeSubtitleVersionIndex: subtitleVersions.length ? Math.min(Math.max(requestedSubtitleIndex, 0), subtitleVersions.length - 1) : 0,
    activeVisualType,
  });
}

export function insertBlankSceneAt(currentScenes, requestedIndex, sceneId = crypto.randomUUID()) {
  const scenes = Array.isArray(currentScenes) ? [...currentScenes] : [];
  if (scenes.length >= 200) throw new RangeError('A project can contain at most 200 scenes.');
  const numericIndex = Number(requestedIndex);
  const insertAt = Number.isFinite(numericIndex)
    ? Math.min(Math.max(Math.trunc(numericIndex), 0), scenes.length)
    : scenes.length;
  const blankScene = normalizeScene({
    id: sceneId,
    title: `Scene ${insertAt + 1}`,
    beat: '',
    scriptFragment: '',
    sourceScriptFragment: '',
    sourceMappingMethod: 'manual',
    narrationText: '',
    narrationIsFallback: false,
    shots: [{
      prompt: '',
      versions: [],
      activeVersionIndex: 0,
      videoVersions: [],
      activeVideoVersionIndex: 0,
    }],
    audioVersions: [],
    activeAudioVersionIndex: 0,
    subtitleVersions: [],
    activeSubtitleVersionIndex: 0,
    activeVisualType: 'image',
  }, insertAt);
  blankScene.sceneNumber = insertAt + 1;
  blankScene.structuralContextStale = false;

  scenes.splice(insertAt, 0, blankScene);
  const renumbered = scenes.map((scene, index) => {
    const isNeighbor = scene.id !== sceneId && Math.abs(index - insertAt) === 1;
    return adaptSceneImageShot({
      ...scene,
      sceneNumber: index + 1,
      title: !scene.title || /^Scene \d+$/.test(scene.title) ? `Scene ${index + 1}` : scene.title,
      ...(isNeighbor ? { structuralContextStale: true } : {}),
    });
  });

  return {
    scenes: renumbered,
    insertedScene: renumbered[insertAt],
    insertAt,
  };
}

// `withinSerial` mirrors the pattern already used by regenerateAudio/regenerateVideo: when true,
// this is being called as one step of a larger operation that already holds uiStore.operation for
// its own full duration (e.g. splitSceneInPlace) — skip acquiring/releasing the lock here so the
// outer operation's lock isn't clobbered mid-flight.
export async function regeneratePrompt(index, els, setStatus, withinSerial = false) {
  const scenes = sceneStore.get().scenes;
  const scene = scenes[index];
  if (!scene || (!withinSerial && uiStore.get().operation)) return;

  if (!withinSerial) uiStore.set({ operation: { type: 'prompt', sceneId: scene.id } });
  try {
    await ensureProjectSynced();
    if (setStatus) setStatus(`Planning prompt ${index + 1}...`);
    const base = getPayloadBase(els);
    const data = await api('/api/storyboard/regenerate-prompt', {
      method: 'POST',
      body: JSON.stringify({
        scriptText: base.scriptText,
        scene,
        sceneIndex: index,
        previousBeat: scenes[index - 1]?.beat || '',
        nextBeat: scenes[index + 1]?.beat || '',
        styleId: base.styleId,
        commonPromptText: base.commonPromptText,
        provider: base.textProvider,
        projectId: base.projectId,
        fallbackPolicy: base.fallbackPolicy,
        enrich: base.enrich,
      }),
    });

    setImagePrompt(scene, textValue(data.prompt, ['prompt']) || scene.prompt);
    // Provenance is server-authored (prompt-generation.service.js only includes these fields on a
    // real, non-fallback regeneration) — copy whatever the server sent rather than computing it from
    // local scene.beat; a fallback response omits them, so the scene keeps its prior provenance.
    if (!data.usedFallback) {
      scene.promptGeneratedFromBeat = data.promptGeneratedFromBeat ?? scene.beat;
      scene.promptGeneratedFromNarration = data.promptGeneratedFromNarration ?? null;
      scene.structuralContextStale = false;
    }
    sceneStore.set({ scenes: [...scenes] }); // trigger reactivity
    const record = getCurrentStoryboardRecord();
    if (record) {
      record.scenes = scenes;
      queueSync(record, setStatus);
    }
    
    if (setStatus) setStatus(data.usedFallback ? data.warning : `Prompt ${index + 1} ready.`);
  } catch (error) {
    if (setStatus) setStatus(`Prompt ${index + 1} failed: ${error.message}`);
  } finally {
    if (!withinSerial) uiStore.set({ operation: null });
  }
}

export async function regenerateAction(index, els, setStatus) {
  const scenes = sceneStore.get().scenes;
  const scene = scenes[index];
  if (!scene || uiStore.get().operation) return;

  uiStore.set({ operation: { type: 'action', sceneId: scene.id } });
  try {
    await ensureProjectSynced();
    if (setStatus) setStatus(`Planning action ${index + 1}...`);
    const base = getPayloadBase(els);
    const data = await api('/api/storyboard/regenerate-action', {
      method: 'POST',
      body: JSON.stringify({
        scriptText: base.scriptText,
        scene,
        sceneIndex: index,
        previousBeat: scenes[index - 1]?.beat || '',
        nextBeat: scenes[index + 1]?.beat || '',
        provider: base.textProvider,
        projectId: base.projectId,
        fallbackPolicy: base.fallbackPolicy,
      }),
    });

    scene.beat = data.beat || scene.beat;
    sceneStore.set({ scenes: [...scenes] });
    const record = getCurrentStoryboardRecord();
    if (record) {
      record.scenes = scenes;
      queueSync(record, setStatus);
    }

    if (setStatus) setStatus(data.usedFallback ? data.warning : `Action ${index + 1} ready.`);
  } catch (error) {
    if (setStatus) setStatus(`Action ${index + 1} failed: ${error.message}`);
  } finally {
    uiStore.set({ operation: null });
  }
}

function currentNarrationInputs(els, base = getPayloadBase(els)) {
  const record = getCurrentStoryboardRecord();
  const selectedHelpers = new Set(record?.narrationHelperIds || []);
  const helperGuidance = (els.narrationHelperButtons || [])
    .filter((button) => selectedHelpers.has(button.dataset.narrationHelperId))
    .map((button) => button.dataset.narrationHelper)
    .filter(Boolean);
  return {
    scriptText: base.scriptText,
    textProvider: base.textProvider,
    enrich: base.enrich,
    guidance: [els.narrationGuidance?.value.trim() || '', ...helperGuidance].filter(Boolean).join(' '),
    helperIds: [...selectedHelpers],
    narrationPromptText: String(record?.narrationPromptOverrides?.[base.enrich ? 'enriched' : 'literal'] || '').trim(),
    maxShots: els.settingsShotLimitSelect ? Number(els.settingsShotLimitSelect.value) || null : null,
  };
}

function narrationNeedsPreparation(els) {
  const scenes = sceneStore.get().scenes;
  if (!scenes.length) return true;
  const last = getCurrentStoryboardRecord()?.lastNarrationInputs;
  if (!last) return false; // Legacy planned projects are treated as reviewed/current.
  const next = currentNarrationInputs(els);
  return String(last.scriptText || '').trim() !== String(next.scriptText || '').trim()
    || String(last.textProvider || '') !== String(next.textProvider || '')
    || Boolean(last.enrich) !== Boolean(next.enrich)
    || String(last.guidance || '') !== String(next.guidance || '')
    || String(last.narrationPromptText || '') !== String(next.narrationPromptText || '')
    || (last.maxShots || null) !== (next.maxShots || null);
}

const MAX_ARCHIVED_NARRATION_PLANS = 8;

function narrationPlanSignature(scenes) {
  return (scenes || []).map((scene) => [
    scene.id,
    scene.sourceStart,
    scene.sourceEnd,
    scene.sourceScriptFragment,
    scene.narrationText,
  ].join('\u0001')).join('\u0002');
}

export function getArchivedNarrationPlans(record = getCurrentStoryboardRecord()) {
  if (!record) return [];
  const plans = Array.isArray(record.archivedNarrationPlans) ? record.archivedNarrationPlans : [];
  const legacyScenes = Array.isArray(record.archivedNarrationScenes) ? record.archivedNarrationScenes : [];
  if (!legacyScenes.length) return plans;
  return [{
    id: 'legacy-narration-archive',
    createdAt: record.updatedAt || record.createdAt || new Date(0).toISOString(),
    label: 'Earlier narration scenes',
    scenes: legacyScenes,
    inputs: null,
  }, ...plans];
}

function archiveNarrationPlan(record, scenes, inputs, label = 'Previous narration plan') {
  if (!record || !scenes?.length) return;
  const signature = narrationPlanSignature(scenes);
  const existing = getArchivedNarrationPlans(record)
    .filter((plan) => narrationPlanSignature(plan.scenes) !== signature);
  record.archivedNarrationPlans = [{
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    label,
    scenes,
    inputs: inputs || null,
  }, ...existing].slice(0, MAX_ARCHIVED_NARRATION_PLANS);
  delete record.archivedNarrationScenes;
}

async function buildNarrationPreparation(els, setStatus) {
  const priorScenes = sceneStore.get().scenes;
  await ensureProjectSynced();
  const base = getPayloadBase(els);
  const inputs = currentNarrationInputs(els, base);
  if (setStatus) setStatus('Preparing narration...');
  const data = await api('/api/storyboard/prepare-narration', {
    method: 'POST',
    body: JSON.stringify({
      projectId: base.projectId,
      scriptText: base.scriptText,
      provider: base.textProvider,
      fallbackPolicy: base.fallbackPolicy,
      enrich: base.enrich,
      guidance: inputs.guidance,
      narrationPromptText: inputs.narrationPromptText,
      ...(inputs.maxShots ? { maxShots: inputs.maxShots } : {}),
    }),
  });
  const preparedScenes = (data.scenes || []).map((scene, index) => normalizeScene(scene, index));
  const keyFor = (scene) => `${String(scene.sourceScriptFragment || scene.scriptFragment || '').trim()}\u0000${String(scene.narrationText || '').trim()}`;
  const priorByContent = new Map();
  for (const scene of priorScenes) {
    const key = keyFor(scene);
    if (!priorByContent.has(key)) priorByContent.set(key, []);
    priorByContent.get(key).push(scene);
  }
  const reusedIds = new Set();
  const nextScenes = preparedScenes.map((prepared, index) => {
    const prior = priorByContent.get(keyFor(prepared))?.shift();
    if (!prior) return prepared;
    reusedIds.add(prior.id);
    return normalizeScene({
      ...prior,
      sceneNumber: index + 1,
      title: prepared.title,
      sourceScriptFragment: prepared.sourceScriptFragment,
      scriptFragment: prepared.scriptFragment,
      sourceStart: prepared.sourceStart,
      sourceEnd: prepared.sourceEnd,
      sourceMappingMethod: prepared.sourceMappingMethod,
      narrationText: prepared.narrationText,
      narrationIsFallback: prepared.narrationIsFallback,
    }, index);
  });
  const displaced = priorScenes.filter((scene) => !reusedIds.has(scene.id));
  return {
    data,
    inputs,
    priorScenes,
    nextScenes,
    displaced,
    reusedCount: reusedIds.size,
  };
}

function commitNarrationPreparation(preparation, setStatus) {
  const { data, inputs, priorScenes, nextScenes, displaced, reusedCount } = preparation;
  sceneStore.set({ scenes: nextScenes });
  const record = getCurrentStoryboardRecord();
  if (record) {
    record.scenes = nextScenes;
    if (priorScenes.length && displaced.length) {
      archiveNarrationPlan(record, priorScenes, record.lastNarrationInputs, 'Before narration regeneration');
    }
    record.lastNarrationInputs = inputs;
    record.lastVisualPlanInputs = null;
    record.lastPromptInputs = null;
    queueSync(record, setStatus);
  }
  if (setStatus) setStatus(data.warning || `Prepared ${nextScenes.length} scenes.`);
  return { scenes: nextScenes, displacedCount: displaced.length, reusedCount };
}

async function requestPrepareNarration(els, setStatus) {
  const preparation = await buildNarrationPreparation(els, setStatus);
  return commitNarrationPreparation(preparation, setStatus).scenes;
}

export function restoreArchivedNarrationPlan(planId, setStatus) {
  const record = getCurrentStoryboardRecord();
  if (!record || uiStore.get().operation) return false;
  const plans = getArchivedNarrationPlans(record);
  const selected = plans.find((plan) => plan.id === planId);
  if (!selected?.scenes?.length) return false;
  archiveNarrationPlan(record, sceneStore.get().scenes, record.lastNarrationInputs, 'Before narration restore');
  record.archivedNarrationPlans = (record.archivedNarrationPlans || []).filter((plan) => plan.id !== planId);
  const restoredScenes = selected.scenes.map((scene, index) => normalizeScene(scene, index));
  record.scenes = restoredScenes;
  record.lastNarrationInputs = selected.inputs || null;
  record.lastVisualPlanInputs = null;
  record.lastPromptInputs = null;
  sceneStore.set({ scenes: restoredScenes });
  queueSync(record, setStatus);
  if (setStatus) setStatus(`Restored ${restoredScenes.length} scenes.`);
  return true;
}

export async function prepareNarration(els, setStatus) {
  if (uiStore.get().operation) return;
  if (!els.scriptText.value.trim()) {
    if (setStatus) setStatus('Add a script before preparing narration.');
    return;
  }
  uiStore.set({ operation: { type: 'prepareNarration' } });
  try {
    return await requestPrepareNarration(els, setStatus);
  } catch (error) {
    if (setStatus) setStatus(`Narration failed: ${error.message}`);
    throw error;
  } finally {
    uiStore.set({ operation: null });
  }
}

async function requestPlanVisuals(els, setStatus) {
  const currentScenes = sceneStore.get().scenes;
  if (!currentScenes.length) throw new Error('Prepare narration before planning visuals.');
  await ensureProjectSynced();
  const base = getPayloadBase(els);
  if (setStatus) setStatus('Planning visuals...');
  const data = await api('/api/storyboard/plan-visuals', {
    method: 'POST',
    body: JSON.stringify({
      projectId: base.projectId,
      scenes: currentScenes,
      styleId: base.styleId,
      commonPromptText: base.commonPromptText,
      provider: base.textProvider,
      fallbackPolicy: base.fallbackPolicy,
    }),
  });
  const nextScenes = (data.scenes || []).map((scene, index) => normalizeScene(scene, index));
  const visualInputs = {
    styleId: base.styleId,
    commonPromptText: base.commonPromptText,
    textProvider: base.textProvider,
    narration: nextScenes.map((scene) => ({ id: scene.id, narrationText: scene.narrationText })),
  };
  const narrationInputs = currentNarrationInputs(els, base);
  const lastPromptInputs = {
    scriptText: narrationInputs.scriptText,
    styleId: base.styleId,
    commonPromptText: base.commonPromptText,
    textProvider: base.textProvider,
    enrich: narrationInputs.enrich,
    maxShots: narrationInputs.maxShots,
  };
  sceneStore.set({ scenes: nextScenes, lastPromptInputs });
  const record = getCurrentStoryboardRecord();
  if (record) {
    record.scenes = nextScenes;
    record.lastVisualPlanInputs = visualInputs;
    record.lastPromptInputs = lastPromptInputs;
    queueSync(record, setStatus);
  }
  if (setStatus) setStatus(data.warning || `Planned ${nextScenes.length} visuals.`);
  return nextScenes;
}

export async function planVisuals(els, setStatus) {
  if (uiStore.get().operation) return;
  uiStore.set({ operation: { type: 'planVisuals' } });
  try {
    return await requestPlanVisuals(els, setStatus);
  } catch (error) {
    if (setStatus) setStatus(`Planning failed: ${error.message}`);
    throw error;
  } finally {
    uiStore.set({ operation: null });
  }
}

// One-click Storyboard planning remains an orchestrator: it prepares narration only when missing or
// stale, then plans visuals over those exact scene IDs/boundaries without rewriting their words.
export async function planShots(els, setStatus) {
  if (uiStore.get().operation) return;
  if (!els.scriptText.value.trim()) {
    if (setStatus) setStatus('Add a story before planning the storyboard.');
    return;
  }
  uiStore.set({ operation: { type: 'planShots' } });
  try {
    if (narrationNeedsPreparation(els)) await requestPrepareNarration(els, setStatus);
    const scenes = await requestPlanVisuals(els, setStatus);
    return scenes.length;
  } catch (error) {
    if (setStatus) setStatus(`Storyboard failed: ${error.message}`);
    throw error;
  } finally {
    uiStore.set({ operation: null });
  }
}

export async function regenerateDialogue(index, els, setStatus, instruction = '', withinSerial = false) {
  const scenes = sceneStore.get().scenes;
  const scene = scenes[index];
  if (!scene || (!withinSerial && uiStore.get().operation)) return;

  if (!withinSerial) uiStore.set({ operation: { type: 'dialogue', sceneId: scene.id } });
  try {
    await ensureProjectSynced();
    if (setStatus) setStatus(`Planning narration ${index + 1}...`);
    const base = getPayloadBase(els);
    const data = await api('/api/storyboard/regenerate-dialogue', {
      method: 'POST',
      body: JSON.stringify({
        scene,
        sceneIndex: index,
        instruction,
        provider: base.textProvider,
        projectId: base.projectId,
        fallbackPolicy: base.fallbackPolicy,
        enrich: base.enrich,
        narrationPromptText: currentNarrationInputs(els, base).narrationPromptText,
      }),
    });

    scene.narrationText = textValue(data.narrationText, ['narrationText']) || textValue(scene.narrationText, ['narrationText']);
    scene.narrationIsFallback = Boolean(data.usedFallback);
    sceneStore.set({ scenes: [...scenes] });
    const record = getCurrentStoryboardRecord();
    if (record) {
      record.scenes = scenes;
      queueSync(record, setStatus);
    }

    if (setStatus) setStatus(data.usedFallback ? data.warning : `Narration ${index + 1} ready.`);
  } catch (error) {
    if (setStatus) setStatus(`Narration failed: ${error.message}`);
  } finally {
    if (!withinSerial) uiStore.set({ operation: null });
  }
}

export async function regenerateImage(index, scene, els, setStatus, withinSerial = false) {
  const scenes = sceneStore.get().scenes;
  // If scene wasn't passed directly (from batch), we take it from index
  const activeScene = scene || scenes[index];
  if (!activeScene || (!scene && uiStore.get().operation)) return;
  if (!String(activeScene.prompt || '').trim()) {
    if (withinSerial) {
      if (setStatus) setStatus(`Skipped scene ${index + 1}: no prompt.`);
      return true;
    }
    throw new Error('Scene has no visual prompt. Add or generate a visual plan first.');
  }
  
  if (!scene) {
    uiStore.set({ operation: { type: 'image', sceneId: activeScene.id } });
  }
  
  try {
    if (!withinSerial) await ensureProjectSynced();
    const base = getPayloadBase(els);
    const payload = {
      sceneNumber: index + 1,
      sceneId: activeScene.id,
      sceneTitle: activeScene.title,
      scenePrompt: activeScene.prompt,
      styleId: base.styleId,
      commonPromptText: base.commonPromptText,
      provider: base.imageProvider,
      projectId: base.projectId,
    };
    if (base.imageProvider !== 'stub') {
      if (setStatus) setStatus('Checking references...');
      const preflight = await api('/api/images/preflight', { method: 'POST', body: JSON.stringify(payload) });
      // The server-authored reference plan remains bound to generation by its hash, but provider
      // limits no longer interrupt the workflow with a browser alert. Included and omitted
      // references remain visible in the resulting generation manifest.
      payload.confirmedReferencePlanHash = preflight.referencePlanHash;
    }
    if (setStatus) setStatus(`Generating image ${index + 1}...`);
    const idempotencyKey = await logicalIdempotencyKey('image', { versionCount: imageShot(activeScene).versions?.length || 0, payload });
    const data = await api('/api/images/generate', {
      method: 'POST',
      idempotencyKey,
      body: JSON.stringify(payload),
    });

    replaceImageState(activeScene, data.scene);
    activeScene.activeVisualType = data.scene.activeVisualType;

    sceneStore.set({ scenes: [...scenes] });
    const record = getCurrentStoryboardRecord();
    if (record) {
      record.scenes = scenes;
      record.revision = data.revision;
      queueSync(record, setStatus);
    }

    if (setStatus) {
      setStatus(`Image ${index + 1} ready.`);
    }
  } catch (error) {
    if (setStatus) setStatus(`Image ${index + 1} failed: ${error.message}`);
    throw error;
  } finally {
    if (!scene) {
      uiStore.set({ operation: null });
    }
  }
}

export async function regenerateAudio(index, scene, els, setStatus, withinSerial = false) {
  const DAEMON_AUDIO_PROVIDERS = ['spark'];
  const scenes = sceneStore.get().scenes;
  const activeScene = scene || scenes[index];
  if (!activeScene || (!scene && uiStore.get().operation)) return;
  if (!activeScene.narrationText?.trim()) {
    // Same class of problem as the narrationIsFallback check below (this scene isn't ready for
    // audio yet) — treat it the same way: skip just this scene in a batch run instead of aborting
    // the whole thing, matching regenerateVideo's equivalent missing-prerequisite guard.
    if (withinSerial) {
      if (setStatus) setStatus(`Skipped scene ${index + 1}: no narration.`);
      return true;
    }
    throw new Error('Scene has no spoken narration. Generate narration first.');
  }
  // Fallback narration is degraded placeholder text (the scene's terse action beat), not a real
  // adaptation — synthesizing paid TTS from it would silently waste money on low-quality audio.
  // Batch runs skip these scenes (and say so); an explicit single-scene regenerate throws so the
  // user has to consciously deal with it rather than the app quietly proceeding.
  if (activeScene.narrationIsFallback) {
    if (withinSerial) {
      if (setStatus) setStatus(`Skipped scene ${index + 1}: placeholder narration.`);
      return true;
    }
    throw new Error("This scene's narration is fallback placeholder text, not real narration — regenerate narration before generating audio.");
  }

  const audioProvider = voiceStore.get().audioProvider;

  if (!scene) {
    uiStore.set({ operation: { type: 'audio', sceneId: activeScene.id } });
  }

  try {
    if (!withinSerial) await ensureProjectSynced();
    if (setStatus) setStatus(`Generating audio ${index + 1}...`);
    const payload = {
      sceneNumber: index + 1,
      sceneId: activeScene.id,
      sceneTitle: activeScene.title,
      narrationText: activeScene.narrationText,
      provider: audioProvider,
      voice: voiceStore.get().narratorVoice[audioProvider] || null,
      projectId: projectStore.get().currentId,
    };
    const idempotencyKey = await logicalIdempotencyKey('audio', { versionCount: activeScene.audioVersions?.length || 0, payload });
    const data = await api('/api/audio/generate', {
      method: 'POST',
      idempotencyKey,
      body: JSON.stringify(payload),
    });

    activeScene.audioVersions = data.scene.audioVersions;
    activeScene.activeAudioVersionIndex = data.scene.activeAudioVersionIndex;

    sceneStore.set({ scenes: [...scenes] });
    const record = getCurrentStoryboardRecord();
    if (record) {
      record.scenes = scenes;
      record.revision = data.revision;
      queueSync(record, setStatus);
    }

    if (setStatus) setStatus(`Audio ${index + 1} ready.`);
  } catch (error) {
    if (setStatus) setStatus(`Audio ${index + 1} failed: ${error.message}`);
    throw error;
  } finally {
    if (!scene) {
      uiStore.set({ operation: null });
    }
  }
}

export async function regenerateSubtitles(index, scene, els, setStatus, withinSerial = false) {
  const scenes = sceneStore.get().scenes;
  const activeScene = scene || scenes[index];
  if (!activeScene || (!scene && uiStore.get().operation)) return;
  const activeAudio = activeScene.audioVersions?.[activeScene.activeAudioVersionIndex];
  if (!activeAudio?.alignment?.words?.length) {
    // Same "skip in a batch, throw on an explicit single-scene call" shape regenerateAudio/
    // regenerateVideo use for their own missing-prerequisite guards above.
    if (withinSerial) {
      if (setStatus) setStatus(`Skipped scene ${index + 1}: no audio timing.`);
      return true;
    }
    throw new Error('This scene has no audio timing data yet. Generate (or regenerate) audio first.');
  }

  if (!scene) {
    uiStore.set({ operation: { type: 'subtitle', sceneId: activeScene.id } });
  }

  try {
    if (!withinSerial) await ensureProjectSynced();
    if (setStatus) setStatus(`Generating subtitles ${index + 1}...`);
    const payload = {
      sceneNumber: index + 1,
      sceneId: activeScene.id,
      sceneTitle: activeScene.title,
      captionStyle: els.subtitleStyleSelect ? els.subtitleStyleSelect.value : 'classic',
      projectId: projectStore.get().currentId,
    };
    const idempotencyKey = await logicalIdempotencyKey('subtitle', { versionCount: activeScene.subtitleVersions?.length || 0, sourceAudioPath: activeAudio.path, payload });
    const data = await api('/api/subtitles/generate', {
      method: 'POST',
      idempotencyKey,
      body: JSON.stringify(payload),
    });

    activeScene.subtitleVersions = data.scene.subtitleVersions;
    activeScene.activeSubtitleVersionIndex = data.scene.activeSubtitleVersionIndex;

    sceneStore.set({ scenes: [...scenes] });
    const record = getCurrentStoryboardRecord();
    if (record) {
      record.scenes = scenes;
      record.revision = data.revision;
      queueSync(record, setStatus);
    }

    if (setStatus) setStatus(`Subtitles ${index + 1} ready.`);
  } catch (error) {
    if (setStatus) setStatus(`Subtitles ${index + 1} failed: ${error.message}`);
    throw error;
  } finally {
    if (!scene) {
      uiStore.set({ operation: null });
    }
  }
}

export async function preflightSparkProvider(setStatus) {
  try {
    await api('/api/audio/spark/preflight');
    return true;
  } catch (error) {
    if (setStatus) setStatus(`Cloning unavailable: ${error.message}`);
    return false;
  }
}

export function zipDownloadFilename(title, now = new Date()) {
  const safeTitle = String(title || 'storyboard').normalize('NFKC').trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 100) || 'storyboard';
  const timestamp = now.toISOString().slice(0, 19).replace('T', '_').replaceAll(':', '-');
  return `${safeTitle}-${timestamp}.zip`;
}

export async function downloadZip(setStatus) {
  if (uiStore.get().operation) return;
  uiStore.set({ operation: { type: 'downloadZip' } });
  try {
    await ensureProjectSynced();
    if (setStatus) setStatus('Building ZIP...');
    const data = await api('/api/images/zip', {
      method: 'POST',
      body: JSON.stringify({ projectId: projectStore.get().currentId }),
    });
    const { downloadProtectedUrl } = await import('../core/assets.js');
    const title = getCurrentStoryboardRecord()?.title || 'storyboard';
    await downloadProtectedUrl(data.zipPath, zipDownloadFilename(title));
    if (setStatus) setStatus('ZIP ready.');
  } catch (error) {
    if (setStatus) setStatus(`ZIP failed: ${error.message}`);
  } finally {
    if (uiStore.get().operation?.type === 'downloadZip') uiStore.set({ operation: null });
  }
}

export async function preflightVideoProvider(setStatus, selection = {}) {
  try {
    const query = new URLSearchParams(Object.entries(selection).filter(([, value]) => value));
    await api(`/api/videos/preflight${query.size ? `?${query}` : ''}`);
    return true;
  } catch (error) {
    if (setStatus) setStatus(`Video preflight failed: ${error.message}`);
    return false;
  }
}

const VIDEO_ATTEMPT_STATE_LABELS = {
  preparing_assets: 'preparing assets',
  submitted: 'queued',
  provider_running: 'rendering',
  validating: 'downloading',
};

// Async video providers (MiniMax, Veo) return { pending: true, attemptId } immediately -- the
// background reconciliation worker is what actually advances and commits the attempt server-side.
// This just watches for that to land, rather than re-driving the provider itself. timeoutMs is kept
// above the server's own VIDEO_ATTEMPT_TIMEOUT_MS (15 min default) so the client stays around long
// enough to see the server's own timeout failure land, instead of giving up first and leaving the
// user unsure whether it's still running.
async function waitForVideoAttempt(attemptId, { intervalMs = 4000, timeoutMs = 16 * 60 * 1000, onProgress } = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  for (;;) {
    const { attempt } = await api(`/api/videos/attempts/${encodeURIComponent(attemptId)}`);
    if (attempt.lifecycleState === 'committed') return attempt;
    if (['failed', 'cancelled'].includes(attempt.lifecycleState)) {
      throw new Error(attempt.error?.message || `Video generation ${attempt.lifecycleState}.`);
    }
    if (onProgress) onProgress({ attempt, elapsedMs: Date.now() - startedAt });
    if (Date.now() >= deadline) {
      throw new Error('Video generation is taking longer than expected — check back in a bit; it may still finish in the background.');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function regenerateVideo(index, scene, els, setStatus, withinSerial = false) {
  const scenes = sceneStore.get().scenes;
  const activeScene = scene || scenes[index];
  if (!activeScene || (!scene && uiStore.get().operation)) return false;
  
  const shot = imageShot(activeScene);
  const activeImage = shot.versions[shot.activeVersionIndex];
  const startFramePath = shot.startFrame || activeImage?.path || null;
  if (!startFramePath) {
    if (withinSerial) return true; // skip this scene
    throw new Error('Scene has no generated reference image.');
  }

  const selectedProvider = els.videoProvider?.value || '';
  const confirmedKeyframes = shot.videoKeyframeSelection?.source === 'video_generation_confirmation'
    && shot.videoKeyframeSelection.startFrame === shot.startFrame
    && (shot.videoKeyframeSelection.endFrame || null) === (shot.endFrame || null)
    ? shot.videoKeyframeSelection
    : null;
  const generationMode = selectedProvider === 'minimax' && confirmedKeyframes?.endFrame ? 'first_last_frame' : undefined;
  if (!withinSerial && !(await preflightVideoProvider(setStatus, { provider: selectedProvider, generationMode }))) return false;

  if (!scene) {
    uiStore.set({ operation: { type: 'video', sceneId: activeScene.id } });
  }

  try {
    if (!withinSerial) await ensureProjectSynced();
    if (setStatus) setStatus(`Generating video ${index + 1}...`);
    const base = getPayloadBase(els);
    const payload = {
      sceneNumber: index + 1,
      sceneId: activeScene.id,
      sceneTitle: activeScene.title,
      scenePrompt: activeScene.prompt,
      sceneBeat: activeScene.beat,
      styleId: base.styleId,
      commonPromptText: base.commonPromptText,
      motionIntensity: els.videoMotionIntensity.value,
      projectId: base.projectId,
      ...(selectedProvider ? { provider: selectedProvider } : {}),
      ...(generationMode ? { generationMode } : {}),
    };
    const idempotencyKey = await logicalIdempotencyKey('video', { versionCount: shot.videoVersions?.length || 0, payload });
    const data = await api('/api/videos/generate', {
      method: 'POST',
      idempotencyKey,
      body: JSON.stringify(payload),
    });

    if (data.pending) {
      // Batch runs don't block on an async provider per scene -- reconciliation happens in the
      // background regardless of whether this tab is open, and waiting here serially would make a
      // multi-scene MiniMax run take minutes per scene for no benefit.
      if (withinSerial) {
        if (setStatus) setStatus(`Video ${index + 1} background generation started.`);
        return false;
      }
      if (setStatus) setStatus(`Generating video ${index + 1}...`);
      await waitForVideoAttempt(data.attemptId, {
        onProgress: ({ attempt, elapsedMs }) => {
          if (!setStatus) return;
          const seconds = Math.round(elapsedMs / 1000);
          const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
          const stage = VIDEO_ATTEMPT_STATE_LABELS[attempt.lifecycleState] || attempt.lifecycleState;
          setStatus(`Video ${index + 1}: ${stage} (${elapsed}).`);
        },
      });
      await hydrateCurrentProjectFromServer();
      if (setStatus) setStatus(`Video ${index + 1} ready.`);
      return false;
    }

    replaceVideoState(activeScene, data.scene);
    activeScene.activeVisualType = data.scene.activeVisualType;

    sceneStore.set({ scenes: [...scenes] });
    const record = getCurrentStoryboardRecord();
    if (record) {
      record.scenes = scenes;
      record.revision = data.revision;
      queueSync(record, setStatus);
    }

    if (setStatus) setStatus(`Video ${index + 1} ready.`);
    return false;
  } catch (error) {
    if (setStatus) setStatus(`Video ${index + 1} failed: ${error.message}`);
    throw error;
  } finally {
    if (!scene) {
      uiStore.set({ operation: null });
    }
  }
}

// Removes `deleteCount` scenes starting at `start` and inserts `newSceneObjects` in their place,
// then renumbers every scene's `sceneNumber` sequentially. This is the one primitive both mid-run
// insertion paths (§5 of the plan) reduce to — a scene worth more than one slide gets replaced by
// its split, everything after shifts, nothing else about the array changes.
export function spliceScenesAndRenumber(scenes, start, deleteCount, newSceneObjects) {
  const next = [...scenes];
  next.splice(start, deleteCount, ...newSceneObjects);
  return next.map((scene, i) => ({ ...scene, sceneNumber: i + 1 }));
}

function anyGenerationInFlight() {
  if (uiStore.get().operation) return true;
  return Object.values(batchStore.get()).some((entry) => entry?.generating);
}

// Splits one existing scene's fragment into `count` new scenes at that position, then populates
// real content for just the new scenes — everything else in the array is untouched. Used both for
// the manual-edit-then-regenerate case and, repeatedly, for accepting a slide-count recommendation
// (see addRecommendedScenes below).
// The split call is AI-driven and story-boundary-aware (see scene-split.service.js): it preserves
// the parent's existing scriptFragment/narrationText verbatim, only dividing it, and is validated
// server-side to guarantee that before it's ever accepted. So when it succeeds (`!data.usedFallback`)
// each child already carries its real narration — no separate regeneration call, and no risk of the
// reviewed/edited narration that justified the split in the first place being discarded and
// rewritten. Only the deterministic last-resort fallback (script-only, no narration) still needs the
// old per-child regenerateDialogue fill-in, exactly as before AI splitting existed.
// Holds uiStore.operation for the ENTIRE split workflow — splice, fill-in regeneration, and
// persistence — not just the initial splice call. Releasing the lock early (between the splice and
// the fill-in loop, or between fill-in steps) would let another entry point that only checks
// uiStore.operation start concurrently and race writes onto the same sceneStore.scenes array. The
// inner regenerateDialogue/regeneratePrompt calls are told `withinSerial=true` so they don't
// separately acquire/release the lock this function already holds.
export async function splitSceneInPlace(index, rawCount, els, setStatus) {
  const count = clampSplitCount(rawCount);
  const scenes = sceneStore.get().scenes;
  const scene = scenes[index];
  if (!scene || anyGenerationInFlight()) return false;
  if (!scene.scriptFragment) throw new Error('Scene has no source fragment to split.');

  uiStore.set({ operation: { type: 'splitScene', sceneId: scene.id } });
  try {
    await ensureProjectSynced();
    if (setStatus) setStatus(`Splitting scene ${index + 1}...`);
    const base = getPayloadBase(els);
    // Real narration exists independent of the Enrich setting (Enrich only controls how elaborate
    // *new* narration generation is, not whether this scene already has real narration to preserve
    // here) — only a fallback placeholder is excluded, never sent as source-of-truth text to split.
    const narrationSource = scene.narrationText && !scene.narrationIsFallback ? scene.narrationText : '';
    const data = await api('/api/storyboard/split-scene', {
      method: 'POST',
      body: JSON.stringify({
        projectId: base.projectId,
        scriptFragment: scene.scriptFragment,
        count,
        narrationText: narrationSource,
        provider: base.textProvider,
        fallbackPolicy: base.fallbackPolicy,
      }),
    });

    // The backend titles each split fragment locally ("Scene 1", "Scene 2"...) since it has no idea
    // where in the real storyboard this split is happening — rename here using the parent scene's
    // own title so split scenes read as "Motel Arrival — 1" instead of colliding with whatever
    // unrelated scene actually occupies storyboard position 1 or 2.
    const parentTitle = scene.title || `Scene ${index + 1}`;
    const newScenes = (data.scenes || []).map((newScene, offset) => normalizeScene({ ...newScene, title: `${parentTitle} — ${offset + 1}` }, 0));
    const nextScenes = spliceScenesAndRenumber(scenes, index, 1, newScenes);
    sceneStore.set({ scenes: nextScenes });
    const record = getCurrentStoryboardRecord();
    if (record) { record.scenes = nextScenes; queueSync(record, setStatus); }

    // Fill in real content for the newly-inserted scenes one at a time — each call reads the
    // current sceneStore fresh, so this is safe even though the array shape already changed above.
    // Use newScenes.length (what was actually spliced in), not the originally requested `count` —
    // the backend may have returned fewer scenes than asked for when the source couldn't support it.
    // Narration is only regenerated here when the deterministic fallback ran (data.usedFallback) —
    // an AI-validated split already carries real preserved narration in newScenes, and regenerating
    // it here would be exactly the "discard and rewrite" behavior this whole feature exists to avoid.
    const needsNarrationFillIn = data.usedFallback && Boolean(narrationSource);
    for (let offset = 0; offset < newScenes.length; offset += 1) {
      const newIndex = index + offset;
      if (needsNarrationFillIn) await regenerateDialogue(newIndex, els, setStatus, '', true);
      await regeneratePrompt(newIndex, els, setStatus, true);
    }
    const doneMessage = `Scene ${index + 1} split into ${newScenes.length} scene${newScenes.length === 1 ? '' : 's'}.`;
    // usedFallback is surfaced in the status line (not just returned) so the deterministic fallback
    // path is visible without having to inspect network traffic, per the "make it visible" intent.
    if (setStatus) setStatus(data.usedFallback ? `${doneMessage} ${data.warning}` : doneMessage);
    return true;
  } catch (error) {
    if (setStatus) setStatus(`Scene split failed: ${error.message}`);
    throw error;
  } finally {
    uiStore.set({ operation: null });
  }
}
