import { projectStore, sceneStore, voiceStore } from './store.js';
import { api } from './api.js';
import { revokeAllAssets } from './assets.js';

const TEXT_PROVIDERS = ['gemini', 'openai', 'stub'];
const IMAGE_PROVIDERS = ['gemini', 'openai', 'dezgo', 'stub'];
const MOTION_INTENSITIES = ['subtle', 'medium', 'high'];

const STORYBOARD_LIBRARY_KEY = 'storyboard-poc-storyboards';
const LEGACY_STORYBOARD_KEYS = ['storyboard-poc-current', 'storyboard-poc-draft'];
export let serverSyncTimer = null;

function parseStoredObject(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch (_) {
    return null;
  }
}

export function createStoryboardRecord(storyboard = {}, title = 'Untitled storyboard') {
  return {
    ...storyboard,
    id: typeof storyboard.id === 'string' && storyboard.id ? storyboard.id : crypto.randomUUID(),
    title: String(storyboard.title || title),
    updatedAt: storyboard.updatedAt || new Date().toISOString(),
  };
}

export function initializeStoryboardLibrary() {
  const stored = parseStoredObject(localStorage.getItem(STORYBOARD_LIBRARY_KEY));
  if (stored && Array.isArray(stored.storyboards) && stored.storyboards.length) {
    const storyboards = stored.storyboards.map((item) => createStoryboardRecord(item));
    const currentId = storyboards.some((item) => item.id === stored.currentId)
      ? stored.currentId
      : storyboards[0].id;
    projectStore.set({ version: 3, currentId, storyboards });
    return;
  }

  const legacy = LEGACY_STORYBOARD_KEYS
    .map((key) => parseStoredObject(localStorage.getItem(key)))
    .find(Boolean);
  const first = createStoryboardRecord(legacy || {});
  projectStore.set({ version: 3, currentId: first.id, storyboards: [first] });
  persistStoryboardLibrary();
}

export function persistStoryboardLibrary() {
  localStorage.setItem(STORYBOARD_LIBRARY_KEY, JSON.stringify(projectStore.get()));
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
    if (!serverScene) return localScene;
    
    return {
      ...localScene,
      versions: mergeVersions(serverScene.versions, localScene.versions),
      audioVersions: mergeVersions(serverScene.audioVersions, localScene.audioVersions),
      videoVersions: mergeVersions(serverScene.videoVersions, localScene.videoVersions),
      activeVersionIndex: serverScene.versions?.length ? serverScene.activeVersionIndex || 0 : localScene.activeVersionIndex || 0,
      activeAudioVersionIndex: serverScene.audioVersions?.length ? serverScene.activeAudioVersionIndex || 0 : localScene.activeAudioVersionIndex || 0,
      activeVideoVersionIndex: serverScene.videoVersions?.length ? serverScene.activeVideoVersionIndex || 0 : localScene.activeVideoVersionIndex || 0,
      activeVisualType: serverScene.activeVisualType || localScene.activeVisualType,
    };
  });
  
  // Add any server scenes that are not locally present (if they were added from another device)
  for (const sScene of serverScenesArr) {
    if (!mergedScenes.some(lScene => lScene.id === sScene.id)) {
      mergedScenes.push(sScene);
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
    Object.assign(record, { revision: serverProject.revision, scenes: mergedScenes.length ? mergedScenes : serverProject.scenes });
    
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
        persistStoryboardLibrary();
        return;
      }
    }
    const saved = await api(`/api/projects/${encodeURIComponent(record.id)}`, { method: 'PUT', headers: { 'If-Match': `"${record.revision}"` }, body: JSON.stringify(project) });
    Object.assign(record, saved.project);
    
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
  sceneStore.set({ scenes: record?.scenes || [], lastPromptInputs: record?.lastPromptInputs || null });
  if (!record) return;

  els.scriptText.value = record.scriptText || '';
  els.sceneCount.value = record.sceneCount || 8;
  els.textProvider.value = TEXT_PROVIDERS.includes(record.textProvider) ? record.textProvider : 'gemini';
  els.imageProvider.value = IMAGE_PROVIDERS.includes(record.imageProvider) ? record.imageProvider : 'gemini';
  els.fallbackPolicy.value = record.fallbackPolicy === 'fail' ? 'fail' : 'local';
  els.videoMotionIntensity.value = MOTION_INTENSITIES.includes(record.videoMotionIntensity) ? record.videoMotionIntensity : 'medium';
  if (record.styleId) els.styleSelect.value = record.styleId;
  if (record.commonPromptText != null) els.commonPromptText.value = record.commonPromptText;

  const audioProvider = ['elevenlabs', 'piper', 'spark', 'stub'].includes(record.audioProvider) ? record.audioProvider : 'stub';
  els.audioProvider.value = audioProvider;
  voiceStore.set({
    audioProvider,
    voiceMap: {
      elevenlabs: record.voiceMap?.elevenlabs || {},
      piper: record.voiceMap?.piper || {},
      spark: record.voiceMap?.spark || {},
      stub: record.voiceMap?.stub || {},
    },
  });
}

export async function restoreStoryboardLibrary(els) {
  initializeStoryboardLibrary();
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
  const record = createStoryboardRecord({}, 'Untitled storyboard');
  projectStore.set((state) => ({ currentId: record.id, storyboards: [...state.storyboards, record] }));
  persistStoryboardLibrary();
  sceneStore.set({ scenes: [], lastPromptInputs: null });

  els.scriptText.value = '';
  els.sceneCount.value = 8;
  els.commonPromptText.value = '';
  els.fallbackPolicy.value = 'local';
  els.videoMotionIntensity.value = 'medium';
}

export function saveStoryboard(els, immediate = false) {
  const record = getCurrentStoryboardRecord();
  if (!record) return;

  Object.assign(record, {
    scriptText: els.scriptText.value,
    sceneCount: Number(els.sceneCount.value) || 8,
    styleId: els.styleSelect.value,
    commonPromptText: els.commonPromptText.value,
    textProvider: els.textProvider.value,
    imageProvider: els.imageProvider.value,
    fallbackPolicy: els.fallbackPolicy.value,
    videoMotionIntensity: els.videoMotionIntensity.value,
    audioProvider: voiceStore.get().audioProvider,
    voiceMap: voiceStore.get().voiceMap,
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
