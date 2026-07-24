'use strict';

const ARTIFACTS = ['screenplay', 'storyboard', 'timeline'];

const ARTIFACT_FIELDS = {
  screenplay: { visibility: 'visibility', publishedAt: 'publishedAt' },
  storyboard: { visibility: 'storyboardVisibility', publishedAt: 'storyboardPublishedAt' },
  timeline: { visibility: 'timelineVisibility', publishedAt: 'timelinePublishedAt' },
};

function isArtifact(value) {
  return ARTIFACTS.includes(value);
}

function normalizeVisibility(value) {
  return value === 'public' ? 'public' : 'private';
}

function artifactsFromRow(row = {}) {
  return {
    screenplay: artifactState(row, 'screenplay'),
    storyboard: artifactState(row, 'storyboard'),
    timeline: artifactState(row, 'timeline'),
  };
}

/** Read one artifact's visibility state without allocating the full artifacts map. */
function artifactState(row = {}, artifact = 'screenplay') {
  const key = isArtifact(artifact) ? artifact : 'screenplay';
  const fields = ARTIFACT_FIELDS[key];
  const nested = row.artifacts?.[key];
  return {
    visibility: normalizeVisibility(row[fields.visibility] ?? nested?.visibility),
    publishedAt: row[fields.publishedAt] || nested?.publishedAt || null,
  };
}

function isArtifactPublic(row, artifact = 'screenplay') {
  return artifactState(row, artifact).visibility === 'public';
}

function hasAnyPublicArtifact(row) {
  for (let i = 0; i < ARTIFACTS.length; i += 1) {
    if (isArtifactPublic(row, ARTIFACTS[i])) return true;
  }
  return false;
}

/** Patch fields for store/prisma update when toggling one artifact's visibility. */
function artifactVisibilityPatch(artifact, visibility, existing = {}) {
  const key = isArtifact(artifact) ? artifact : 'screenplay';
  const fields = ARTIFACT_FIELDS[key];
  const next = normalizeVisibility(visibility);
  const patch = { [fields.visibility]: next };
  if (next === 'public') {
    const current = existing[fields.publishedAt] || existing.artifacts?.[key]?.publishedAt || null;
    patch[fields.publishedAt] = current || new Date().toISOString();
  } else {
    patch[fields.publishedAt] = null;
  }
  return patch;
}

function visibilityWhere(artifact = 'screenplay') {
  const key = isArtifact(artifact) ? artifact : 'screenplay';
  return { [ARTIFACT_FIELDS[key].visibility]: 'public' };
}

function publishedAtOrder(artifact = 'screenplay') {
  const key = isArtifact(artifact) ? artifact : 'screenplay';
  return ARTIFACT_FIELDS[key].publishedAt;
}

module.exports = {
  ARTIFACTS,
  ARTIFACT_FIELDS,
  isArtifact,
  normalizeVisibility,
  artifactsFromRow,
  artifactState,
  isArtifactPublic,
  hasAnyPublicArtifact,
  artifactVisibilityPatch,
  visibilityWhere,
  publishedAtOrder,
};
