const REFERENCE_ROLES = Object.freeze(['character', 'location', 'composition', 'continuity']);

function normalizeReferenceRole(role) {
  return REFERENCE_ROLES.includes(role) ? role : 'composition';
}

function normalizeReferenceImages(references) {
  return (Array.isArray(references) ? references : []).map((reference) => ({
    ...reference,
    role: normalizeReferenceRole(reference?.role),
  }));
}

module.exports = { REFERENCE_ROLES, normalizeReferenceImages, normalizeReferenceRole };
