import { projectStore, sceneStore, voiceStore } from './store.js';
import { api } from './api.js';
import { revokeAllAssets } from './assets.js';
import { adaptSceneImageShot, adaptSceneImageShots, imageShot } from './scene-shots.js';

// Valid provider/intensity values live in index.html's <select> options — the single
// source of truth. Reading them here avoids a second, driftable copy of that enumeration.
function optionValues(selectEl) {
  return [...selectEl.options].map((option) => option.value);
}

let storyboardLibraryKey = 'storyboard-poc-storyboards:anonymous';
export let serverSyncTimer = null;

export function setPersistenceScope(tenantId) {
  storyboardLibraryKey = `storyboard-poc-storyboards:${String(tenantId || 'anonymous')}`;
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

export function createStoryboardRecord(storyboard = {}, title = 'Untitled') {
  const record = {
    ...storyboard,
    id: typeof storyboard.id === 'string' && storyboard.id ? storyboard.id : crypto.randomUUID(),
    title: String(storyboard.title || title),
    updatedAt: storyboard.updatedAt || new Date().toISOString(),
  };
  record.scenes = adaptSceneImageShots(record.scenes);
  return record;
}

export function initializeStoryboardLibrary() {
  const stored = parseStoredObject(localStorage.getItem(storyboardLibraryKey));
  if (stored && Array.isArray(stored.storyboards) && stored.storyboards.length) {
    const storyboards = stored.storyboards.map((item) => createStoryboardRecord(item));
    const currentId = storyboards.some((item) => item.id === stored.currentId)
      ? stored.currentId
      : storyboards[0].id;
    projectStore.set({ version: 3, currentId, storyboards });
    return;
  }

  const first = createStoryboardRecord({});
  projectStore.set({ version: 3, currentId: first.id, storyboards: [first] });
  persistStoryboardLibrary();
}

export function persistStoryboardLibrary() {
  localStorage.setItem(storyboardLibraryKey, JSON.stringify(projectStore.get()));
}

export function getCurrentStoryboardRecord() {
  const state = projectStore.get();
  return state.storyboards.find((item) => item.id === state.currentId) || null;
}

export async function ensureProjectSynced() {
  const record = getCurrentStoryboardRecord();
  if (!record) return;
  clearTimeout(serverSyncTimer);
  serverSyncTimer = null;
  await syncProjectRecord(record);
}

function assetKey(version) {
  try { return decodeURIComponent(String(version?.path || '').split('/').pop() || ''); }
  catch (_) { return String(version?.path || ''); }
}

function mergeVersions(serverVersions, localVersions) {
  const merged = new Map();
  for (const version of [...(serverVersions || []), ...(localVersions || [])]) {
    const key = assetKey(version);
    if (key && !merged.has(key)) merged.set(key, version);
  }
  return [...merged.values()];
}

// Matches scenes by ID
function mergeScenes(serverScenes, localScenes) {
  const serverScenesArr = Array.isArray(serverScenes) ? serverScenes : [];
  const localScenesArr = Array.isArray(localScenes) ? localScenes : [];
  
  const mergedScenes = localScenesArr.map((localScene) => {
    const serverScene = serverScenesArr.find((scene) => scene.id === localScene.id);
    const local = adaptSceneImageShot(localScene);
    if (!serverScene) return local;

    const server = adaptSceneImageShot(serverScene);
    const localShot = imageShot(local);
    const serverShot = imageShot(server);
    return adaptSceneImageShot({
      ...local,
      shots: [{
        ...localShot,
        versions: mergeVersions(serverShot.versions, localShot.versions),
        activeVersionIndex: serverShot.versions?.length
          ? serverShot.activeVersionIndex || 0
          : localShot.activeVersionIndex || 0,
        videoVersions: mergeVersions(serverShot.videoVersions, localShot.videoVersions),
        activeVideoVersionIndex: serverShot.videoVersions?.length
          ? serverShot.activeVideoVersionIndex || 0
          : localShot.activeVideoVersionIndex || 0,
      }, ...(local.shots || []).slice(1)],
      audioVersions: mergeVersions(serverScene.audioVersions, localScene.audioVersions),
      activeAudioVersionIndex: serverScene.audioVersions?.length ? serverScene.activeAudioVersionIndex || 0 : localScene.activeAudioVersionIndex || 0,
      activeVisualType: serverScene.activeVisualType || localScene.activeVisualType,
    });
  });
  
  // Add any server scenes that are not locally present (if they were added from another device)
  for (const sScene of serverScenesArr) {
    if (!mergedScenes.some(lScene => lScene.id === sScene.id)) {
      mergedScenes.push(adaptSceneImageShot(sScene));
    }
  }

  return mergedScenes;
}

export async function hydrateCurrentProjectFromServer() {
  const record = getCurrentStoryboardRecord();
  if (!record) return;
  try {
    const response = await api(`/api/projects/${encodeURIComponent(record.id)}`);
    const serverProject = response.project;
    
    const mergedScenes = mergeScenes(serverProject.scenes, record.scenes);
    Object.assign(record, {
      revision: serverProject.revision,
      scenes: mergedScenes.length ? mergedScenes : adaptSceneImageShots(serverProject.scenes),
    });
    
    persistStoryboardLibrary();
    // Update local scene store if this is the active project
    if (record.id === projectStore.get().currentId) {
      sceneStore.set({ scenes: record.scenes });
    }
  } catch (error) {
    if (error.code !== 'PROJECT_NOT_FOUND') throw error;
  }
}

export async function syncProjectRecord(record, setStatus) {
  record.scenes = adaptSceneImageShots(record.scenes);
  const project = { ...record, id: record.id, title: record.title };
  try {
    if (!Number.isInteger(record.revision)) {
      try {
        const existing = await api(`/api/projects/${encodeURIComponent(record.id)}`);
        record.revision = existing.project.revision;
      } catch (error) {
        if (error.code !== 'PROJECT_NOT_FOUND') throw error;
        const created = await api('/api/projects', { method: 'POST', body: JSON.stringify({ id: record.id, title: record.title, project }) });
        Object.assign(record, created.project);
        record.scenes = adaptSceneImageShots(record.scenes);
        persistStoryboardLibrary();
        return;
      }
    }
    const saved = await api(`/api/projects/${encodeURIComponent(record.id)}`, { method: 'PUT', headers: { 'If-Match': `"${record.revision}"` }, body: JSON.stringify(project) });
    Object.assign(record, saved.project);
    record.scenes = adaptSceneImageShots(record.scenes);
    
    if (record.id === projectStore.get().currentId) {
      // Re-hydrate the scene store to make sure everything matches (like paths changing or revision updates)
      sceneStore.set({ scenes: (record.scenes || []) });
    }
    persistStoryboardLibrary();
  } catch (error) {
    if (error.code === 'REVISION_CONFLICT') {
      if (setStatus) setStatus('This project changed elsewhere. Reopen it before saving again.');
    } else {
      if (setStatus) setStatus(`Project sync failed: ${error.message}`);
    }
  }
}

export function queueSync(record, setStatus) {
  clearTimeout(serverSyncTimer);
  serverSyncTimer = setTimeout(() => syncProjectRecord(record, setStatus), 250);
}

function restoreStoryboardFields(els) {
  const record = getCurrentStoryboardRecord();
  if (record) record.scenes = adaptSceneImageShots(record.scenes);
  sceneStore.set({ scenes: record?.scenes || [], lastPromptInputs: record?.lastPromptInputs || null });
  if (!record) return;

  els.scriptText.value = record.scriptText || '';
  els.textProvider.value = optionValues(els.textProvider).includes(record.textProvider) ? record.textProvider : 'gemini';
  els.imageProvider.value = optionValues(els.imageProvider).includes(record.imageProvider) ? record.imageProvider : 'gemini';
  if (els.mediaAspectRatio) els.mediaAspectRatio.value = optionValues(els.mediaAspectRatio).includes(record.mediaSettings?.aspectRatio) ? record.mediaSettings.aspectRatio : '';
  if (els.imageResolutionTier) els.imageResolutionTier.value = optionValues(els.imageResolutionTier).includes(record.mediaSettings?.image?.resolutionTier) ? record.mediaSettings.image.resolutionTier : 'standard';
  if (els.imageQuality) els.imageQuality.value = optionValues(els.imageQuality).includes(record.mediaSettings?.image?.quality) ? record.mediaSettings.image.quality : 'medium';
  if (els.videoResolutionTier) els.videoResolutionTier.value = optionValues(els.videoResolutionTier).includes(record.mediaSettings?.video?.resolutionTier) ? record.mediaSettings.video.resolutionTier : 'draft';
  if (els.videoDurationSeconds) {
    const duration = String(record.mediaSettings?.video?.durationSeconds || '');
    els.videoDurationSeconds.value = optionValues(els.videoDurationSeconds).includes(duration) ? duration : '';
  }
  if (els.videoProvider) els.videoProvider.value = optionValues(els.videoProvider).includes(record.mediaSettings?.video?.provider) ? record.mediaSettings.video.provider : '';
  els.fallbackPolicy.value = record.fallbackPolicy === 'fail' ? 'fail' : 'local';
  els.videoMotionIntensity.value = optionValues(els.videoMotionIntensity).includes(record.videoMotionIntensity) ? record.videoMotionIntensity : 'medium';
  if (els.subtitleStyleSelect) {
    els.subtitleStyleSelect.value = optionValues(els.subtitleStyleSelect).includes(record.subtitleStyle) ? record.subtitleStyle : 'classic';
  }
  els.enrichNarration.checked = record.enrich === true;
  if (record.styleId) {
    els.styleSelect.value = record.styleId;
    if (els.stageStyleSelect) els.stageStyleSelect.value = record.styleId;
  }
  if (record.commonPromptText != null) els.commonPromptText.value = record.commonPromptText;
  if (els.settingsShotLimitSelect) {
    els.settingsShotLimitSelect.value = optionValues(els.settingsShotLimitSelect).includes(String(record.maxShots || '')) ? String(record.maxShots || '') : '';
  }

  const audioProvider = optionValues(els.audioProvider).includes(record.audioProvider) ? record.audioProvider : 'stub';
  els.audioProvider.value = audioProvider;
  voiceStore.set({
    audioProvider,
    narratorVoice: {
      elevenlabs: record.narratorVoice?.elevenlabs || null,
      piper: record.narratorVoice?.piper || null,
      spark: record.narratorVoice?.spark || null,
      stub: record.narratorVoice?.stub || null,
    },
  });
}

export async function restoreStoryboardLibrary(els) {
  initializeStoryboardLibrary();
  const response = await api('/api/projects');
  const state = projectStore.get();
  const merged = new Map((state.storyboards || []).map((project) => [project.id, project]));
  for (const serverProject of response.projects || []) {
    const local = merged.get(serverProject.id);
    merged.set(serverProject.id, local ? { ...serverProject, ...local, revision: serverProject.revision } : createStoryboardRecord(serverProject));
  }
  const storyboards = [...merged.values()].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const currentId = storyboards.some((project) => project.id === state.currentId) ? state.currentId : storyboards[0]?.id;
  projectStore.set({ version: 3, currentId, storyboards });
  persistStoryboardLibrary();
  await hydrateCurrentProjectFromServer();
  restoreStoryboardFields(els);
}

export async function openStoryboard(id, els) {
  revokeAllAssets();
  projectStore.set({ currentId: id });
  persistStoryboardLibrary();
  await hydrateCurrentProjectFromServer();
  restoreStoryboardFields(els);
}

export function createStoryboard(els) {
  revokeAllAssets();
  const record = createStoryboardRecord({}, 'Untitled');
  projectStore.set((state) => ({ currentId: record.id, storyboards: [...state.storyboards, record] }));
  persistStoryboardLibrary();
  sceneStore.set({ scenes: [], lastPromptInputs: null });

  els.scriptText.value = '';
  els.commonPromptText.value = '';
  els.fallbackPolicy.value = 'local';
  els.videoMotionIntensity.value = 'medium';
  if (els.subtitleStyleSelect) els.subtitleStyleSelect.value = 'classic';
  els.enrichNarration.checked = false;
  if (els.settingsShotLimitSelect) els.settingsShotLimitSelect.value = '';
  if (els.mediaAspectRatio) els.mediaAspectRatio.value = '';
  if (els.imageResolutionTier) els.imageResolutionTier.value = 'standard';
  if (els.imageQuality) els.imageQuality.value = 'medium';
  if (els.videoResolutionTier) els.videoResolutionTier.value = 'draft';
  if (els.videoDurationSeconds) els.videoDurationSeconds.value = '';
  if (els.videoProvider) els.videoProvider.value = '';
}

export function saveStoryboard(els, immediate = false) {
  const record = getCurrentStoryboardRecord();
  if (!record) return;

  Object.assign(record, {
    title: String(els.storyboardTitle?.value || '').trim() || 'Untitled',
    scriptText: els.scriptText.value,
    styleId: els.styleSelect.value,
    commonPromptText: els.commonPromptText.value,
    textProvider: els.textProvider.value,
    imageProvider: els.imageProvider.value,
    // Media controls are independent project settings. A blank aspect ratio/provider means
    // "inherit" for that field; it must not prevent resolution or quality changes from saving.
    mediaSettings: {
      version: 1,
      ...(els.mediaAspectRatio?.value ? { aspectRatio: els.mediaAspectRatio.value } : {}),
      image: { resolutionTier: els.imageResolutionTier.value, quality: els.imageQuality.value },
      video: {
        resolutionTier: els.videoResolutionTier.value,
        ...(els.videoDurationSeconds?.value ? { durationSeconds: Number(els.videoDurationSeconds.value) } : {}),
        ...(els.videoProvider?.value ? { provider: els.videoProvider.value } : {}),
      },
    },
    fallbackPolicy: els.fallbackPolicy.value,
    videoMotionIntensity: els.videoMotionIntensity.value,
    subtitleStyle: els.subtitleStyleSelect ? els.subtitleStyleSelect.value : 'classic',
    enrich: els.enrichNarration.checked,
    maxShots: els.settingsShotLimitSelect ? (Number(els.settingsShotLimitSelect.value) || null) : null,
    audioProvider: voiceStore.get().audioProvider,
    narratorVoice: voiceStore.get().narratorVoice,
    scenes: sceneStore.get().scenes,
    lastPromptInputs: sceneStore.get().lastPromptInputs,
    updatedAt: new Date().toISOString(),
  });
  persistStoryboardLibrary();

  if (els.saveStateBtn) {
    els.saveStateBtn.textContent = 'Saved';
    els.saveStateBtn.disabled = true;
  }
  const reportStatus = (text) => { if (els.statusText) els.statusText.textContent = text; };
  if (immediate) {
    syncProjectRecord(record, reportStatus).catch(() => {
      if (els.saveStateBtn) {
        els.saveStateBtn.textContent = 'Retry save';
        els.saveStateBtn.disabled = false;
      }
    });
  } else {
    queueSync(record, reportStatus);
  }
}
