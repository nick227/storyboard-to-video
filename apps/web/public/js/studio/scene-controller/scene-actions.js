import { sceneStore, debounce } from '../../core/store.js';
import { getCurrentStoryboardRecord, queueSync, persistStoryboardLibrary } from '../../core/persistence.js';
import { adaptSceneImageShot, imageShot, setActiveImageVersion, setActiveVideoVersion, setVideoKeyframes } from '../../core/scene-shots.js';
import { clearEntityOverride, setEntityOverride } from '../../core/scene-entity-config.js';
import { invalidateVideoMotion } from '../../generation/workflows.js';

let lastStatusTextCallback = null;
const debouncedQueueSync = debounce(() => {
  const record = getCurrentStoryboardRecord();
  if (record) {
    queueSync(record, lastStatusTextCallback);
  }
}, 500);

export function replaceScene(index, updateFn) {
  updateScene(index, updateFn, { sync: 'immediate' });
}

export function updateScene(index, updateFn, { sync = 'immediate', statusCallback = null, revision = null } = {}) {
  const scenes = sceneStore.get().scenes;
  const nextScenes = scenes.map((scene, i) => {
    if (i !== index) return scene;
    const next = { ...scene };
    updateFn(next);
    return next;
  });

  sceneStore.set({ scenes: nextScenes });

  const record = getCurrentStoryboardRecord();
  if (record) {
    record.scenes = nextScenes;
    if (revision !== null) {
      record.revision = revision;
    }
    
    if (sync === 'immediate') {
      queueSync(record, statusCallback);
    } else if (sync === 'debounced') {
      lastStatusTextCallback = statusCallback;
      debouncedQueueSync(statusCallback);
    } else if (sync === 'local') {
      persistStoryboardLibrary();
    }
  }
}

export function updateSceneById(sceneId, updateFn, options = {}) {
  const scenes = sceneStore.get().scenes;
  const index = scenes.findIndex((s) => s.id === sceneId);
  if (index !== -1) {
    updateScene(index, updateFn, options);
  }
}

export function applySceneConfigOverride(index, type, override) {
  updateScene(index, (scene) => setEntityOverride(scene, type, override));
}

export function clearSceneConfigOverride(index, type) {
  updateScene(index, (scene) => clearEntityOverride(scene, type));
}

export function selectSceneEntityVersion(index, type, versionIndex) {
  updateScene(index, (scene) => {
    if (type === 'image') {
      setActiveImageVersion(scene, versionIndex);
      scene.activeVisualType = 'image';
    } else if (type === 'video') {
      setActiveVideoVersion(scene, versionIndex);
      scene.activeVisualType = 'video';
    } else if (type === 'audio') {
      scene.activeAudioVersionIndex = versionIndex;
    } else if (type === 'subtitle') {
      scene.activeSubtitleVersionIndex = versionIndex;
    }
  }, { sync: 'immediate' });
}

export function applyVideoKeyframes(index, startFrame, endFrame) {
  updateScene(index, (scene) => {
    setVideoKeyframes(scene, startFrame, endFrame);
  }, { sync: 'immediate' });
}

export function replaceSceneFromServer(data) {
  const updated = adaptSceneImageShot(data.scene);
  updateSceneById(updated.id, (scene) => {
    Object.assign(scene, updated);
  }, { sync: 'local', revision: data.revision });
}

export function toggleDefaultReference(index, url, checked, statusCallback) {
  updateScene(index, (scene) => {
    const next = adaptSceneImageShot(scene);
    const shot = imageShot(next);
    const disabled = new Set(shot.disabledStyleReferencePaths || []);
    if (checked) disabled.delete(url); else disabled.add(url);
    shot.disabledStyleReferencePaths = [...disabled];
    Object.assign(scene, next);
  }, { sync: 'immediate', statusCallback });
}
