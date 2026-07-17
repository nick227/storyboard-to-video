import { api } from './api.js';
import { projectStore, sceneStore, voiceStore, generationStore, uiStore } from './store.js';
import { getCurrentStoryboardRecord, queueSync, ensureProjectSynced } from './persistence.js';

export function getPayloadBase(els) {
  return {
    projectId: projectStore.get().currentId,
    scriptText: els.scriptText.value,
    sceneCount: Number(els.sceneCount.value || 8),
    styleId: els.styleSelect.value,
    commonPromptText: els.commonPromptText.value,
    textProvider: els.textProvider.value,
    imageProvider: els.imageProvider.value,
    fallbackPolicy: els.fallbackPolicy.value,
  };
}

export function normalizeScene(scene, index) {
  const projectPrefix = `/projects/${encodeURIComponent(projectStore.get().currentId || '')}/assets/`;
  const versions = Array.isArray(scene?.versions)
    ? scene.versions.filter((version) => typeof version?.path === 'string' && (version.path.startsWith(`${projectPrefix}images/`) || version.path.startsWith('/generated/')))
    : [];
  const requestedIndex = Number.isInteger(scene?.activeVersionIndex) ? scene.activeVersionIndex : 0;
  // Server-authoritative normalization (project-store.js) is what actually adapts legacy `lines`
  // into `narrationText`. This is only a trivial client-side fallback for stale local-cached data
  // that hasn't round-tripped through the server yet — not a reimplementation of that adapter.
  const narrationText = typeof scene?.narrationText === 'string' ? scene.narrationText : '';
  const narrationIsFallback = Boolean(scene?.narrationIsFallback);
  const audioVersions = Array.isArray(scene?.audioVersions)
    ? scene.audioVersions.filter((version) => typeof version?.path === 'string' && (version.path.startsWith(`${projectPrefix}audio/`) || version.path.startsWith('/audio/')))
    : [];
  const requestedAudioIndex = Number.isInteger(scene?.activeAudioVersionIndex) ? scene.activeAudioVersionIndex : 0;
  
  const videoVersions = Array.isArray(scene?.videoVersions)
    ? scene.videoVersions.filter((version) => typeof version?.path === 'string' && (version.path.startsWith(`${projectPrefix}videos/`) || version.path.startsWith('/videos/')))
    : [];
  const requestedVideoIndex = Number.isInteger(scene?.activeVideoVersionIndex) ? scene.activeVideoVersionIndex : (videoVersions.length ? videoVersions.length - 1 : 0);
  
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
    scriptFragment: typeof scene?.scriptFragment === 'string' ? scene.scriptFragment : '',
    promptGeneratedFromBeat: typeof scene?.promptGeneratedFromBeat === 'string' ? scene.promptGeneratedFromBeat : '',
    versions,
    activeVersionIndex: versions.length ? Math.min(Math.max(requestedIndex, 0), versions.length - 1) : 0,
    narrationText,
    narrationIsFallback,
    audioVersions,
    activeAudioVersionIndex: audioVersions.length ? Math.min(Math.max(requestedAudioIndex, 0), audioVersions.length - 1) : 0,
    videoVersions,
    activeVideoVersionIndex: videoVersions.length ? Math.min(Math.max(requestedVideoIndex, 0), videoVersions.length - 1) : 0,
    activeVisualType,
  };
}

export async function generatePrompts(els, setStatus) {
  if (uiStore.get().operation) return;
  uiStore.set({ operation: { type: 'prompts' } });
  
  try {
    await ensureProjectSynced();
    if (setStatus) setStatus('Generating scene prompts...');
    const base = getPayloadBase(els);
    const data = await api('/api/storyboard/generate-prompts', {
      method: 'POST',
      body: JSON.stringify({
        scriptText: base.scriptText,
        sceneCount: base.sceneCount,
        styleId: base.styleId,
        commonPromptText: base.commonPromptText,
        provider: base.textProvider,
        projectId: base.projectId,
        fallbackPolicy: base.fallbackPolicy,
      }),
    });

    const previousScenes = sceneStore.get().scenes;
    const nextScenes = (data.scenes || []).map((nextScene, index) => normalizeScene({
      ...nextScene,
      promptGeneratedFromBeat: nextScene.beat,
      id: previousScenes[index]?.id || nextScene.id,
      versions: previousScenes[index]?.versions || [],
      activeVersionIndex: previousScenes[index]?.activeVersionIndex || 0,
      videoVersions: previousScenes[index]?.videoVersions || [],
      activeVideoVersionIndex: previousScenes[index]?.activeVideoVersionIndex || 0,
      activeVisualType: previousScenes[index]?.activeVisualType,
    }, index));
    
    sceneStore.set({ 
      scenes: nextScenes,
      lastPromptInputs: { scriptText: base.scriptText, commonPromptText: base.commonPromptText } 
    });
    
    const record = getCurrentStoryboardRecord();
    if (record) {
      record.scenes = nextScenes;
      record.lastPromptInputs = sceneStore.get().lastPromptInputs;
      queueSync(record, setStatus);
    }
    
    if (setStatus) setStatus(data.usedFallback ? data.warning : `Generated ${nextScenes.length} scene prompts with ${base.textProvider}.`);
  } catch (error) {
    if (setStatus) setStatus(`Prompt generation failed: ${error.message}`);
  } finally {
    uiStore.set({ operation: null });
  }
}

export async function regeneratePrompt(index, els, setStatus) {
  const scenes = sceneStore.get().scenes;
  const scene = scenes[index];
  if (!scene || uiStore.get().operation) return;
  
  uiStore.set({ operation: { type: 'prompt', sceneId: scene.id } });
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
      }),
    });

    scene.prompt = data.prompt || scene.prompt;
    if (!data.usedFallback) scene.promptGeneratedFromBeat = scene.beat;
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
    uiStore.set({ operation: null });
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
  const scenes = sceneStore.get().scenes;
  if (uiStore.get().operation || !scenes.length) {
    if (!scenes.length && setStatus) setStatus('Generate scene prompts first.');
    return;
  }

  uiStore.set({ operation: { type: 'dialogueAll' } });
  try {
    await ensureProjectSynced();
    if (setStatus) setStatus('Writing spoken narration...');
    const base = getPayloadBase(els);
    const data = await api('/api/storyboard/generate-dialogue', {
      method: 'POST',
      body: JSON.stringify({
        scenes: scenes.map((scene, index) => ({ sceneNumber: index + 1, title: scene.title, beat: scene.beat, scriptFragment: scene.scriptFragment })),
        provider: base.textProvider,
        projectId: base.projectId,
        fallbackPolicy: base.fallbackPolicy,
      }),
    });

    (data.scenesDialogue || []).forEach((sceneDialogue, index) => {
      if (scenes[index]) {
        scenes[index].narrationText = sceneDialogue.narrationText || '';
        scenes[index].narrationIsFallback = Boolean(data.usedFallback);
      }
    });

    sceneStore.set({ scenes: [...scenes] });
    const record = getCurrentStoryboardRecord();
    if (record) {
      record.scenes = scenes;
      queueSync(record, setStatus);
    }

    if (setStatus) setStatus(data.usedFallback ? data.warning : `Wrote spoken narration for ${scenes.length} scenes with ${base.textProvider}.`);
  } catch (error) {
    if (setStatus) setStatus(`Narration generation failed: ${error.message}`);
  } finally {
    uiStore.set({ operation: null });
  }
}

export async function regenerateDialogue(index, els, setStatus, instruction = '') {
  const scenes = sceneStore.get().scenes;
  const scene = scenes[index];
  if (!scene || uiStore.get().operation) return;

  uiStore.set({ operation: { type: 'dialogue', sceneId: scene.id } });
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
    uiStore.set({ operation: null });
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

    activeScene.versions = data.scene.versions;
    activeScene.activeVersionIndex = data.scene.activeVersionIndex;
    activeScene.activeVisualType = data.scene.activeVisualType;

    sceneStore.set({ scenes: [...scenes] });
    const record = getCurrentStoryboardRecord();
    if (record) {
      record.scenes = scenes;
      record.revision = data.revision;
      queueSync(record, setStatus);
    }

    if (setStatus) setStatus(`Image ready for scene ${index + 1}. ${data.referenceCount || 0} style refs used.`);
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
  if (!activeScene.narrationText?.trim()) throw new Error('Scene has no spoken narration. Generate narration first.');
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
  
  const sourceImage = activeScene.versions[activeScene.activeVersionIndex];
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

    activeScene.videoVersions = data.scene.videoVersions;
    activeScene.activeVideoVersionIndex = data.scene.activeVideoVersionIndex;
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
