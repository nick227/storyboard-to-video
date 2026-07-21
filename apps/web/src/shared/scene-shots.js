const IMAGE_FIELDS = Object.freeze(['prompt', 'versions', 'activeVersionIndex']);
const VIDEO_FIELDS = Object.freeze(['videoVersions', 'activeVideoVersionIndex']);
const SHOT_FIELDS = Object.freeze([...IMAGE_FIELDS, ...VIDEO_FIELDS]);
const { normalizeReferenceImages } = require('./reference-roles');

function textValue(value, preferredKey) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  for (const key of [preferredKey, 'text', 'value', 'content', 'output']) {
    if (!key || !Object.prototype.hasOwnProperty.call(value, key)) continue;
    const nested = textValue(value[key], preferredKey);
    if (nested) return nested;
  }
  return '';
}

function legacyShot(scene = {}) {
  const versions = Array.isArray(scene.versions) ? scene.versions : [];
  const requestedIndex = Number.isInteger(scene.activeVersionIndex) ? scene.activeVersionIndex : 0;
  const videoVersions = Array.isArray(scene.videoVersions) ? scene.videoVersions : [];
  const requestedVideoIndex = Number.isInteger(scene.activeVideoVersionIndex) ? scene.activeVideoVersionIndex : 0;
  return {
    prompt: textValue(scene.prompt, 'prompt'),
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

function imageShot(scene = {}) {
  const shot = Array.isArray(scene.shots) && scene.shots[0] && typeof scene.shots[0] === 'object'
    ? scene.shots[0]
    : null;
  return shot || legacyShot(scene);
}

function migrateSceneImageToImplicitShot(scene = {}) {
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
  const shot = {
    ...(existing || {}),
    prompt: textValue(existing?.prompt, 'prompt') || legacy.prompt,
    versions,
    activeVersionIndex: versions.length ? Math.min(Math.max(requestedIndex, 0), versions.length - 1) : 0,
    videoVersions,
    activeVideoVersionIndex: videoVersions.length ? Math.min(Math.max(requestedVideoIndex, 0), videoVersions.length - 1) : 0,
    referenceBindings,
    disabledStyleReferencePaths,
    startFrame,
    endFrame,
    videoKeyframeSelection,
  };

  scene.shots = [shot, ...existingShots.slice(1)];
  for (const field of SHOT_FIELDS) delete scene[field];
  delete scene.referenceImages;
  delete scene.disabledProjectReferenceImages;
  return scene;
}

function attachLegacyImageProjection(scene = {}) {
  migrateSceneImageToImplicitShot(scene);
  for (const field of SHOT_FIELDS) {
    Object.defineProperty(scene, field, {
      configurable: true,
      enumerable: false,
      get() { return imageShot(scene)[field]; },
    });
  }
  Object.defineProperty(scene, 'referenceImages', {
    configurable: true, enumerable: false, get() { return imageShot(scene).referenceBindings; },
  });
  Object.defineProperty(scene, 'disabledProjectReferenceImages', {
    configurable: true, enumerable: false, get() { return imageShot(scene).disabledStyleReferencePaths; },
  });
  return scene;
}

function hasLegacySceneImageState(scene = {}) {
  const shot = Array.isArray(scene.shots) ? scene.shots[0] : null;
  return !shot || !Array.isArray(shot.referenceBindings) || !Array.isArray(shot.disabledStyleReferencePaths) || !Object.prototype.hasOwnProperty.call(shot, 'startFrame') || !Object.prototype.hasOwnProperty.call(shot, 'endFrame') || !Object.prototype.hasOwnProperty.call(shot, 'videoKeyframeSelection') || SHOT_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(scene, field)) || Object.prototype.hasOwnProperty.call(scene, 'referenceImages') || Object.prototype.hasOwnProperty.call(scene, 'disabledProjectReferenceImages');
}

module.exports = {
  IMAGE_FIELDS,
  VIDEO_FIELDS,
  attachLegacyImageProjection,
  hasLegacySceneImageState,
  imageShot,
  migrateSceneImageToImplicitShot,
};
