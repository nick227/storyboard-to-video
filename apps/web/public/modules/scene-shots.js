import { normalizeReferenceImages } from './reference-roles.js';

const IMAGE_FIELDS = ['prompt', 'versions', 'activeVersionIndex'];
const VIDEO_FIELDS = ['videoVersions', 'activeVideoVersionIndex'];
const SHOT_FIELDS = [...IMAGE_FIELDS, ...VIDEO_FIELDS];

function legacyShot(scene = {}) {
  const versions = Array.isArray(scene.versions) ? scene.versions : [];
  const requestedIndex = Number.isInteger(scene.activeVersionIndex) ? scene.activeVersionIndex : 0;
  const videoVersions = Array.isArray(scene.videoVersions) ? scene.videoVersions : [];
  const requestedVideoIndex = Number.isInteger(scene.activeVideoVersionIndex) ? scene.activeVideoVersionIndex : 0;
  return {
    prompt: typeof scene.prompt === 'string' ? scene.prompt : '',
    versions,
    activeVersionIndex: versions.length ? Math.min(Math.max(requestedIndex, 0), versions.length - 1) : 0,
    videoVersions,
    activeVideoVersionIndex: videoVersions.length ? Math.min(Math.max(requestedVideoIndex, 0), videoVersions.length - 1) : 0,
    referenceBindings: normalizeReferenceImages(scene.referenceImages),
    disabledStyleReferencePaths: Array.isArray(scene.disabledProjectReferenceImages) ? scene.disabledProjectReferenceImages : [],
  };
}

export function imageShot(scene = {}) {
  return Array.isArray(scene.shots) && scene.shots[0] && typeof scene.shots[0] === 'object'
    ? scene.shots[0]
    : legacyShot(scene);
}

export function adaptSceneImageShot(scene = {}) {
  const existingShots = Array.isArray(scene.shots) ? scene.shots : [];
  const existing = existingShots[0] && typeof existingShots[0] === 'object' ? existingShots[0] : null;
  const legacy = legacyShot(scene);
  const versions = Array.isArray(existing?.versions) ? existing.versions : legacy.versions;
  const requestedIndex = Number.isInteger(existing?.activeVersionIndex) ? existing.activeVersionIndex : legacy.activeVersionIndex;
  const videoVersions = Array.isArray(existing?.videoVersions) ? existing.videoVersions : legacy.videoVersions;
  const requestedVideoIndex = Number.isInteger(existing?.activeVideoVersionIndex) ? existing.activeVideoVersionIndex : legacy.activeVideoVersionIndex;
  const referenceBindings = Array.isArray(existing?.referenceBindings) ? normalizeReferenceImages(existing.referenceBindings) : legacy.referenceBindings;
  const disabledStyleReferencePaths = Array.isArray(existing?.disabledStyleReferencePaths) ? existing.disabledStyleReferencePaths : legacy.disabledStyleReferencePaths;
  scene.shots = [{
    ...(existing || {}),
    prompt: typeof existing?.prompt === 'string' ? existing.prompt : legacy.prompt,
    versions,
    activeVersionIndex: versions.length ? Math.min(Math.max(requestedIndex, 0), versions.length - 1) : 0,
    videoVersions,
    activeVideoVersionIndex: videoVersions.length ? Math.min(Math.max(requestedVideoIndex, 0), videoVersions.length - 1) : 0,
    referenceBindings,
    disabledStyleReferencePaths,
  }, ...existingShots.slice(1)];

  for (const field of SHOT_FIELDS) {
    delete scene[field];
    Object.defineProperty(scene, field, {
      configurable: true,
      enumerable: false,
      get() { return imageShot(scene)[field]; },
    });
  }
  delete scene.referenceImages;
  delete scene.disabledProjectReferenceImages;
  Object.defineProperty(scene, 'referenceImages', {
    configurable: true, enumerable: false, get() { return imageShot(scene).referenceBindings; },
  });
  Object.defineProperty(scene, 'disabledProjectReferenceImages', {
    configurable: true, enumerable: false, get() { return imageShot(scene).disabledStyleReferencePaths; },
  });
  return scene;
}

export function adaptSceneImageShots(scenes) {
  return (Array.isArray(scenes) ? scenes : []).map((scene) => adaptSceneImageShot(scene));
}

export function setImagePrompt(scene, prompt) {
  adaptSceneImageShot(scene);
  scene.shots[0].prompt = String(prompt || '');
}

export function replaceImageState(scene, sourceScene) {
  adaptSceneImageShot(scene);
  const source = imageShot(sourceScene);
  scene.shots[0].versions = Array.isArray(source.versions) ? source.versions : [];
  scene.shots[0].activeVersionIndex = Number.isInteger(source.activeVersionIndex) ? source.activeVersionIndex : 0;
}

export function setActiveImageVersion(scene, index) {
  adaptSceneImageShot(scene);
  const versions = scene.shots[0].versions;
  scene.shots[0].activeVersionIndex = versions.length ? Math.min(Math.max(Number(index) || 0, 0), versions.length - 1) : 0;
}

export function replaceVideoState(scene, sourceScene) {
  adaptSceneImageShot(scene);
  const source = imageShot(sourceScene);
  scene.shots[0].videoVersions = Array.isArray(source.videoVersions) ? source.videoVersions : [];
  scene.shots[0].activeVideoVersionIndex = Number.isInteger(source.activeVideoVersionIndex) ? source.activeVideoVersionIndex : 0;
}

export function setActiveVideoVersion(scene, index) {
  adaptSceneImageShot(scene);
  const versions = scene.shots[0].videoVersions;
  scene.shots[0].activeVideoVersionIndex = versions.length ? Math.min(Math.max(Number(index) || 0, 0), versions.length - 1) : 0;
}
