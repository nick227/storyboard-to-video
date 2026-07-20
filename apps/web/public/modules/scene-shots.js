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
    startFrame: versions[versions.length ? Math.min(Math.max(requestedIndex, 0), versions.length - 1) : 0]?.path || null,
    endFrame: null,
    videoKeyframeSelection: null,
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
  const defaultStartFrame = versions[versions.length ? Math.min(Math.max(requestedIndex, 0), versions.length - 1) : 0]?.path || null;
  const versionPaths = new Set(versions.map((version) => version?.path).filter(Boolean));
  const startFrame = typeof existing?.startFrame === 'string' && versionPaths.has(existing.startFrame) ? existing.startFrame : defaultStartFrame;
  const endFrame = typeof existing?.endFrame === 'string' && versionPaths.has(existing.endFrame) ? existing.endFrame : null;
  const selection = existing?.videoKeyframeSelection;
  const videoKeyframeSelection = selection?.version === 1
    && selection.source === 'video_generation_confirmation'
    && selection.startFrame === startFrame
    && (selection.endFrame || null) === endFrame
    ? selection
    : null;
  scene.shots = [{
    ...(existing || {}),
    prompt: typeof existing?.prompt === 'string' ? existing.prompt : legacy.prompt,
    versions,
    activeVersionIndex: versions.length ? Math.min(Math.max(requestedIndex, 0), versions.length - 1) : 0,
    videoVersions,
    activeVideoVersionIndex: videoVersions.length ? Math.min(Math.max(requestedVideoIndex, 0), videoVersions.length - 1) : 0,
    referenceBindings,
    disabledStyleReferencePaths,
    startFrame,
    endFrame,
    videoKeyframeSelection,
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
  scene.shots[0].startFrame = typeof source.startFrame === 'string' ? source.startFrame : null;
  scene.shots[0].endFrame = typeof source.endFrame === 'string' ? source.endFrame : null;
  scene.shots[0].videoKeyframeSelection = source.videoKeyframeSelection || null;
}

export function setActiveImageVersion(scene, index) {
  adaptSceneImageShot(scene);
  const versions = scene.shots[0].versions;
  scene.shots[0].activeVersionIndex = versions.length ? Math.min(Math.max(Number(index) || 0, 0), versions.length - 1) : 0;
}

export function setStartFrame(scene, path) {
  adaptSceneImageShot(scene);
  const selected = String(path || '');
  if (selected && !scene.shots[0].versions.some((version) => version?.path === selected)) throw new RangeError('Start frame must reference an image version on this shot');
  scene.shots[0].startFrame = selected || null;
  scene.shots[0].videoKeyframeSelection = null;
}

export function setEndFrame(scene, path) {
  adaptSceneImageShot(scene);
  const selected = String(path || '');
  if (selected && !scene.shots[0].versions.some((version) => version?.path === selected)) throw new RangeError('End frame must reference an image version on this shot');
  scene.shots[0].endFrame = selected || null;
  scene.shots[0].videoKeyframeSelection = null;
}

export function setVideoKeyframes(scene, startPath, endPath = null) {
  adaptSceneImageShot(scene);
  const versions = scene.shots[0].versions;
  const startFrame = String(startPath || '');
  const endFrame = String(endPath || '');
  if (!startFrame || !versions.some((version) => version?.path === startFrame)) throw new RangeError('Video start keyframe must reference an image version on this shot');
  if (endFrame && !versions.some((version) => version?.path === endFrame)) throw new RangeError('Video end keyframe must reference an image version on this shot');
  if (endFrame && endFrame === startFrame) throw new RangeError('Video start and end keyframes must be different images');
  scene.shots[0].startFrame = startFrame;
  scene.shots[0].endFrame = endFrame || null;
  scene.shots[0].videoKeyframeSelection = {
    version: 1,
    source: 'video_generation_confirmation',
    startFrame,
    endFrame: endFrame || null,
    confirmedAt: new Date().toISOString(),
  };
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
