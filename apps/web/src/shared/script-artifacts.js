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
    screenplay: {
      visibility: normalizeVisibility(row.visibility),
      publishedAt: row.publishedAt || null,
    },
    storyboard: {
      visibility: normalizeVisibility(row.storyboardVisibility),
      publishedAt: row.storyboardPublishedAt || null,
    },
    timeline: {
      visibility: normalizeVisibility(row.timelineVisibility),
      publishedAt: row.timelinePublishedAt || null,
    },
  };
}

function artifactState(row, artifact = 'screenplay') {
  const artifacts = artifactsFromRow(row);
  return artifacts[isArtifact(artifact) ? artifact : 'screenplay'];
}

function isArtifactPublic(row, artifact = 'screenplay') {
  return artifactState(row, artifact).visibility === 'public';
}

/** Patch fields for store/prisma update when toggling one artifact's visibility. */
function artifactVisibilityPatch(artifact, visibility, existing = {}) {
  const key = isArtifact(artifact) ? artifact : 'screenplay';
  const fields = ARTIFACT_FIELDS[key];
  const next = normalizeVisibility(visibility);
  const patch = { [fields.visibility]: next };
  if (next === 'public') {
    const current = existing[fields.publishedAt] || artifactState(existing, key).publishedAt;
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
  artifactVisibilityPatch,
  visibilityWhere,
  publishedAtOrder,
};
