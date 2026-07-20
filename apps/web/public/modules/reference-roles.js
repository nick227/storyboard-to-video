export const REFERENCE_ROLES = Object.freeze(['character', 'location', 'composition', 'continuity']);

export const REFERENCE_ROLE_LABELS = Object.freeze({
  character: 'Character',
  location: 'Location',
  composition: 'Composition',
  continuity: 'Continuity',
});

export function normalizeReferenceRole(role) {
  return REFERENCE_ROLES.includes(role) ? role : 'composition';
}

export function normalizeReferenceImages(references) {
  return (Array.isArray(references) ? references : []).map((reference) => ({
    ...reference,
    role: normalizeReferenceRole(reference?.role),
  }));
}
