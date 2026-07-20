import { api } from './api.js';
import { batchStore, projectStore, sceneStore, voiceStore, generationStore, uiStore } from './store.js';
import { getCurrentStoryboardRecord, queueSync, ensureProjectSynced } from './persistence.js';
import { clampSplitCount } from './scene-count.js';
import { adaptSceneImageShot, imageShot, replaceImageState, replaceVideoState, setImagePrompt } from './scene-shots.js';

// sceneCount is a fixed fallback now, not a computed target -- planShots (below) doesn't use this
// field at all, and the only remaining reader is generatePrompts' rebuildFromSource path
// (replanStory), which has no UI-configurable target anymore either.
export function getPayloadBase(els) {
  return {
    projectId: projectStore.get().currentId,
    scriptText: els.scriptText.value,
    sceneCount: 8,
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
  const narrationText = typeof scene?.narrationText === 'string' ? scene.narrationText : '';
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
      prompt: String(sourceShot.prompt || ''),
      versions,
      activeVersionIndex: versions.length ? Math.min(Math.max(requestedIndex, 0), versions.length - 1) : 0,
      videoVersions,
      activeVideoVersionIndex: videoVersions.length ? Math.min(Math.max(requestedVideoIndex, 0), videoVersions.length - 1) : 0,
    }, ...(Array.isArray(scene?.shots) ? scene.shots.slice(1) : [])],
    scriptFragment: typeof scene?.scriptFragment === 'string' ? scene.scriptFragment : '',
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

// `rebuildFromSource: true` is a separate, explicit operation from the default regenerate — it
// re-derives scene boundaries from the raw script at the current sceneCount input, discarding the
// old structure. The default (false) always keeps whatever scenes currently exist as authoritative,
// regardless of what the sceneCount input happens to read — that field can drift from the real
// scene count (e.g. after a scene split) and is never used to infer "did the user want a different
// total scene count." Only an explicit rebuild request re-splits from scratch.
export async function generatePrompts(els, setStatus, { rebuildFromSource = false } = {}) {
  if (uiStore.get().operation) return;
  uiStore.set({ operation: { type: 'prompts' } });

  try {
    await ensureProjectSynced();
    if (setStatus) setStatus(rebuildFromSource ? 'Rebuilding storyboard from source...' : 'Generating scene prompts...');
    const base = getPayloadBase(els);
    const previousScenes = sceneStore.get().scenes;
    const reuseExistingScenes = !rebuildFromSource && previousScenes.length > 0;
    const data = await api('/api/storyboard/generate-prompts', {
      method: 'POST',
      body: JSON.stringify({
        scriptText: base.scriptText,
        sceneCount: reuseExistingScenes ? previousScenes.length : base.sceneCount,
        styleId: base.styleId,
        commonPromptText: base.commonPromptText,
        provider: base.textProvider,
        projectId: base.projectId,
        fallbackPolicy: base.fallbackPolicy,
        enrich: base.enrich,
        ...(reuseExistingScenes ? { existingScenes: previousScenes } : {}),
      }),
    });

    // The backend's prompt response only ever carries {sceneNumber, title, scriptFragment, beat,
    // prompt} — narration/audio have nothing to do with prompt generation, so when boundaries didn't
    // change (reuseExistingScenes) they must be explicitly carried forward or they'd silently vanish.
    // promptGeneratedFromBeat/promptGeneratedFromNarration arrive already stamped by the server
    // (prompt-generation.service.js) — not recomputed here from local scene.beat, so provenance
    // reflects what generation actually used even across reloads/concurrent tabs.
    const nextScenes = (data.scenes || []).map((nextScene, index) => {
      const previousScene = previousScenes[index];
      const previousShot = imageShot(previousScene);
      return normalizeScene({
        ...nextScene,
        id: reuseExistingScenes ? (previousScene?.id || nextScene.id) : nextScene.id,
        shots: [{
          prompt: nextScene.prompt || '',
          versions: reuseExistingScenes ? (previousShot.versions || []) : [],
          activeVersionIndex: reuseExistingScenes ? (previousShot.activeVersionIndex || 0) : 0,
          videoVersions: reuseExistingScenes ? (previousShot.videoVersions || []) : [],
          activeVideoVersionIndex: reuseExistingScenes ? (previousShot.activeVideoVersionIndex || 0) : 0,
          referenceBindings: reuseExistingScenes ? (previousShot.referenceBindings || []) : [],
          disabledStyleReferencePaths: reuseExistingScenes ? (previousShot.disabledStyleReferencePaths || []) : [],
        }],
        activeVisualType: reuseExistingScenes ? previousScene?.activeVisualType : undefined,
        narrationText: reuseExistingScenes ? (previousScene?.narrationText || '') : '',
        narrationIsFallback: reuseExistingScenes ? Boolean(previousScene?.narrationIsFallback) : false,
        audioVersions: reuseExistingScenes ? (previousScene?.audioVersions || []) : [],
        activeAudioVersionIndex: reuseExistingScenes ? (previousScene?.activeAudioVersionIndex || 0) : 0,
        subtitleVersions: reuseExistingScenes ? (previousScene?.subtitleVersions || []) : [],
        activeSubtitleVersionIndex: reuseExistingScenes ? (previousScene?.activeSubtitleVersionIndex || 0) : 0,
      }, index);
    });
    
    sceneStore.set({ 
      scenes: nextScenes,
      lastPromptInputs: {
        scriptText: base.scriptText,
        sceneCount: base.sceneCount,
        styleId: base.styleId,
        commonPromptText: base.commonPromptText,
        textProvider: base.textProvider,
        enrich: base.enrich,
      } 
    });
    
    const record = getCurrentStoryboardRecord();
    if (record) {
      record.scenes = nextScenes;
      record.lastPromptInputs = sceneStore.get().lastPromptInputs;
      queueSync(record, setStatus);
    }
    
    if (setStatus) setStatus(data.usedFallback ? data.warning : `Generated ${nextScenes.length} shot prompts with ${base.textProvider}.`);
  } catch (error) {
    if (setStatus) setStatus(`Prompt generation failed: ${error.message}`);
  } finally {
    uiStore.set({ operation: null });
  }
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
    if (setStatus) setStatus(`Regenerating prompt for scene ${index + 1}...`);
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

    setImagePrompt(scene, data.prompt || scene.prompt);
    // Provenance is server-authored (prompt-generation.service.js only includes these fields on a
    // real, non-fallback regeneration) — copy whatever the server sent rather than computing it from
    // local scene.beat; a fallback response omits them, so the scene keeps its prior provenance.
    if (!data.usedFallback) {
      scene.promptGeneratedFromBeat = data.promptGeneratedFromBeat ?? scene.beat;
      scene.promptGeneratedFromNarration = data.promptGeneratedFromNarration ?? null;
    }
    sceneStore.set({ scenes: [...scenes] }); // trigger reactivity
    const record = getCurrentStoryboardRecord();
    if (record) {
      record.scenes = scenes;
      queueSync(record, setStatus);
    }
    
    if (setStatus) setStatus(data.usedFallback ? data.warning : `Prompt updated for scene ${index + 1}.`);
  } catch (error) {
    if (setStatus) setStatus(`Prompt regeneration failed: ${error.message}`);
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
    if (setStatus) setStatus(`Regenerating action for scene ${index + 1}...`);
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

    if (setStatus) setStatus(data.usedFallback ? data.warning : `Action updated for scene ${index + 1}.`);
  } catch (error) {
    if (setStatus) setStatus(`Action regeneration failed: ${error.message}`);
  } finally {
    uiStore.set({ operation: null });
  }
}

export async function generateDialogue(els, setStatus) {
  if (uiStore.get().operation) return;
  if (!els.scriptText.value.trim()) {
    if (setStatus) setStatus('Add a story before generating narration.');
    return;
  }

  uiStore.set({ operation: { type: 'dialogueAll' } });
  try {
    await ensureProjectSynced();
    const base = getPayloadBase(els);

    // Narration no longer requires prompts to exist first — if this is a dialogue-first run, create
    // the deterministic scene skeleton (script fragments, no LLM call) before narrating it.
    let scenes = sceneStore.get().scenes;
    if (!scenes.length) {
      if (setStatus) setStatus('Creating scenes...');
      const skeleton = await api('/api/storyboard/create-scenes', {
        method: 'POST',
        body: JSON.stringify({ projectId: base.projectId, scriptText: base.scriptText, sceneCount: base.sceneCount }),
      });
      scenes = (skeleton.scenes || []).map((scene, index) => normalizeScene(scene, index));
      sceneStore.set({ scenes });
    }

    if (setStatus) setStatus('Writing spoken narration...');
    const data = await api('/api/storyboard/generate-dialogue', {
      method: 'POST',
      body: JSON.stringify({
        scenes: scenes.map((scene, index) => ({ sceneNumber: index + 1, title: scene.title, beat: scene.beat, scriptFragment: scene.scriptFragment })),
        provider: base.textProvider,
        projectId: base.projectId,
        fallbackPolicy: base.fallbackPolicy,
        enrich: base.enrich,
      }),
    });

    // Read the per-scene fallback flag, not the aggregate data.usedFallback — one scene falling
    // back must not mark every other scene's real narration as fallback too.
    (data.scenesDialogue || []).forEach((sceneDialogue, index) => {
      if (scenes[index]) {
        scenes[index].narrationText = sceneDialogue.narrationText || '';
        scenes[index].narrationIsFallback = Boolean(sceneDialogue.usedFallback);
      }
    });

    sceneStore.set({ scenes: [...scenes] });
    const record = getCurrentStoryboardRecord();
    if (record) {
      record.scenes = scenes;
      queueSync(record, setStatus);
    }

    if (setStatus) setStatus(data.usedFallback ? data.warning : `Wrote spoken narration for ${scenes.length} shots with ${base.textProvider}.`);
  } catch (error) {
    if (setStatus) setStatus(`Narration generation failed: ${error.message}`);
  } finally {
    uiStore.set({ operation: null });
  }
}

// The planning entry point: narration is generated and locked first, then shots are planned from
// that immutable narration server-side in the same request (see shot-planning.service.js) — the
// returned scene list IS the final structure. There is no separate scene-count guess beforehand and
// no recount-and-reconcile step afterward; shot count is simply how many shots came back.
export async function planShots(els, setStatus) {
  if (uiStore.get().operation) return;
  if (!els.scriptText.value.trim()) {
    if (setStatus) setStatus('Add a story before planning shots.');
    return;
  }

  uiStore.set({ operation: { type: 'planShots' } });
  try {
    await ensureProjectSynced();
    if (setStatus) setStatus('Narrating and planning shots...');
    const base = getPayloadBase(els);
    const data = await api('/api/storyboard/plan-shots', {
      method: 'POST',
      body: JSON.stringify({
        projectId: base.projectId,
        scriptText: base.scriptText,
        styleId: base.styleId,
        commonPromptText: base.commonPromptText,
        provider: base.textProvider,
        fallbackPolicy: base.fallbackPolicy,
        enrich: base.enrich,
      }),
    });

    const nextScenes = (data.scenes || []).map((scene, index) => normalizeScene(scene, index));
    const lastPromptInputs = {
      scriptText: base.scriptText,
      styleId: base.styleId,
      commonPromptText: base.commonPromptText,
      textProvider: base.textProvider,
      enrich: base.enrich,
    };
    sceneStore.set({ scenes: nextScenes, lastPromptInputs });

    const record = getCurrentStoryboardRecord();
    if (record) {
      record.scenes = nextScenes;
      record.lastPromptInputs = lastPromptInputs;
      queueSync(record, setStatus);
    }

    if (setStatus) setStatus(data.usedFallback ? data.warning : `Planned ${nextScenes.length} shots with ${base.textProvider}.`);
    return nextScenes.length;
  } catch (error) {
    if (setStatus) setStatus(`Shot planning failed: ${error.message}`);
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
    if (setStatus) setStatus(`Regenerating narration for scene ${index + 1}...`);
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
      }),
    });

    scene.narrationText = data.narrationText || scene.narrationText;
    scene.narrationIsFallback = Boolean(data.usedFallback);
    sceneStore.set({ scenes: [...scenes] });
    const record = getCurrentStoryboardRecord();
    if (record) {
      record.scenes = scenes;
      queueSync(record, setStatus);
    }

    if (setStatus) setStatus(data.usedFallback ? data.warning : `Narration updated for scene ${index + 1}.`);
  } catch (error) {
    if (setStatus) setStatus(`Narration regeneration failed: ${error.message}`);
  } finally {
    if (!withinSerial) uiStore.set({ operation: null });
  }
}

export async function regenerateImage(index, scene, els, setStatus) {
  const scenes = sceneStore.get().scenes;
  // If scene wasn't passed directly (from batch), we take it from index
  const activeScene = scene || scenes[index];
  if (!activeScene || (!scene && uiStore.get().operation)) return;
  
  if (!scene) {
    uiStore.set({ operation: { type: 'image', sceneId: activeScene.id } });
  }
  
  try {
    await ensureProjectSynced();
    if (setStatus) setStatus(`Generating image for scene ${index + 1}...`);
    const base = getPayloadBase(els);
    const data = await api('/api/images/generate', {
      method: 'POST',
      body: JSON.stringify({
        sceneNumber: index + 1,
        sceneId: activeScene.id,
        sceneTitle: activeScene.title,
        scenePrompt: activeScene.prompt,
        styleId: base.styleId,
        commonPromptText: base.commonPromptText,
        provider: base.imageProvider,
        projectId: base.projectId,
      }),
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

    if (setStatus) setStatus(`Image ready for scene ${index + 1}. ${data.referenceCount || 0} reference image${data.referenceCount === 1 ? '' : 's'} used (${data.sceneReferenceCount || 0} scene-only).`);
  } catch (error) {
    if (setStatus) setStatus(`Image generation failed for scene ${index + 1}: ${error.message}`);
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
      if (setStatus) setStatus(`Skipped scene ${index + 1}: no spoken narration yet.`);
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
      if (setStatus) setStatus(`Skipped scene ${index + 1}: narration is fallback placeholder text, not real narration.`);
      return true;
    }
    throw new Error("This scene's narration is fallback placeholder text, not real narration — regenerate narration before generating audio.");
  }

  const audioProvider = voiceStore.get().audioProvider;

  if (!scene) {
    uiStore.set({ operation: { type: 'audio', sceneId: activeScene.id } });
  }

  try {
    await ensureProjectSynced();
    if (setStatus) setStatus(`Generating audio for scene ${index + 1}...`);
    const data = await api('/api/audio/generate', {
      method: 'POST',
      body: JSON.stringify({
        sceneNumber: index + 1,
        sceneId: activeScene.id,
        sceneTitle: activeScene.title,
        narrationText: activeScene.narrationText,
        provider: audioProvider,
        voice: voiceStore.get().narratorVoice[audioProvider] || null,
        projectId: projectStore.get().currentId,
      }),
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

    if (setStatus) setStatus(`Audio ready for scene ${index + 1}.`);
  } catch (error) {
    if (setStatus) setStatus(`Audio generation failed for scene ${index + 1}: ${error.message}`);
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
      if (setStatus) setStatus(`Skipped scene ${index + 1}: no audio timing data yet.`);
      return true;
    }
    throw new Error('This scene has no audio timing data yet. Generate (or regenerate) audio first.');
  }

  if (!scene) {
    uiStore.set({ operation: { type: 'subtitle', sceneId: activeScene.id } });
  }

  try {
    await ensureProjectSynced();
    if (setStatus) setStatus(`Generating subtitles for scene ${index + 1}...`);
    const data = await api('/api/subtitles/generate', {
      method: 'POST',
      body: JSON.stringify({
        sceneNumber: index + 1,
        sceneId: activeScene.id,
        sceneTitle: activeScene.title,
        captionStyle: els.subtitleStyleSelect ? els.subtitleStyleSelect.value : 'classic',
        projectId: projectStore.get().currentId,
      }),
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

    if (setStatus) setStatus(`Subtitles ready for scene ${index + 1}.`);
  } catch (error) {
    if (setStatus) setStatus(`Subtitle generation failed for scene ${index + 1}: ${error.message}`);
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
    if (setStatus) setStatus(`Voice cloning service unavailable: ${error.message}`);
    return false;
  }
}

export async function downloadZip(setStatus) {
  try {
    await ensureProjectSynced();
    if (setStatus) setStatus('Building zip...');
    const data = await api('/api/images/zip', {
      method: 'POST',
      body: JSON.stringify({ projectId: projectStore.get().currentId }),
    });
    const { downloadProtectedUrl } = await import('./assets.js');
    await downloadProtectedUrl(data.zipPath, 'storyboard.zip');
    if (setStatus) setStatus('ZIP ready.');
  } catch (error) {
    if (setStatus) setStatus(`ZIP failed: ${error.message}`);
  }
}

export async function preflightVideoProvider(setStatus) {
  try {
    await api('/api/videos/preflight');
    return true;
  } catch (error) {
    if (setStatus) setStatus(`Video generation aborted during preflight: ${error.message}`);
    return false;
  }
}

export async function regenerateVideo(index, scene, els, setStatus, withinSerial = false) {
  const scenes = sceneStore.get().scenes;
  const activeScene = scene || scenes[index];
  if (!activeScene || (!scene && uiStore.get().operation)) return false;
  
  const shot = imageShot(activeScene);
  const sourceImage = shot.versions[shot.activeVersionIndex];
  if (!sourceImage?.path) {
    if (withinSerial) return true; // skip this scene
    throw new Error('Scene has no generated reference image.');
  }

  if (!withinSerial && !(await preflightVideoProvider(setStatus))) return false;

  if (!scene) {
    uiStore.set({ operation: { type: 'video', sceneId: activeScene.id } });
  }

  try {
    await ensureProjectSynced();
    if (setStatus) setStatus(`Generating video for scene ${index + 1}...`);
    const base = getPayloadBase(els);
    const data = await api('/api/videos/generate', {
      method: 'POST',
      body: JSON.stringify({
        sceneNumber: index + 1,
        sceneId: activeScene.id,
        sceneTitle: activeScene.title,
        scenePrompt: activeScene.prompt,
        sceneBeat: activeScene.beat,
        styleId: base.styleId,
        commonPromptText: base.commonPromptText,
        motionIntensity: els.videoMotionIntensity.value,
        imagePath: sourceImage.path,
        projectId: base.projectId,
      }),
    });

    replaceVideoState(activeScene, data.scene);
    activeScene.activeVisualType = data.scene.activeVisualType;

    sceneStore.set({ scenes: [...scenes] });
    const record = getCurrentStoryboardRecord();
    if (record) {
      record.scenes = scenes;
      record.revision = data.revision;
      queueSync(record, setStatus);
    }

    if (setStatus) setStatus(`Video ready for scene ${index + 1}.`);
    return false;
  } catch (error) {
    if (setStatus) setStatus(`Video generation failed for scene ${index + 1}: ${error.message}`);
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
    if (setStatus) setStatus(`Splitting scene ${index + 1} into ${count} scenes...`);
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
