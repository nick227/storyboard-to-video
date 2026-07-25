const { REFERENCE_ROLES, normalizeReferenceRole } = require('./reference-roles');
const { parseImageProviderSelection } = require('./local-safetensors');

const ALL_ROLES = Object.freeze([...REFERENCE_ROLES]);

const IMAGE_PROVIDER_CAPABILITIES = Object.freeze({
  gemini: Object.freeze({
    maxReferences: 14,
    supportedRoles: ALL_ROLES,
    transport: 'inline_multimodal',
    roleAwarePrompting: true,
    consumesReferences: true,
  }),
  openai: Object.freeze({
    maxReferences: 8,
    supportedRoles: ALL_ROLES,
    transport: 'multi_image_edit',
    roleAwarePrompting: false,
    consumesReferences: true,
  }),
  dezgo: Object.freeze({
    maxReferences: 1,
    supportedRoles: ALL_ROLES,
    transport: 'image_to_image_anchor',
    roleAwarePrompting: false,
    consumesReferences: true,
  }),
  dezgo_flux: Object.freeze({
    maxReferences: 0,
    supportedRoles: Object.freeze([]),
    transport: 'none',
    roleAwarePrompting: false,
    consumesReferences: false,
  }),
  sdxl: Object.freeze({
    maxReferences: 0,
    supportedRoles: Object.freeze([]),
    transport: 'none',
    roleAwarePrompting: false,
    consumesReferences: false,
  }),
  stub: Object.freeze({
    maxReferences: 0,
    supportedRoles: Object.freeze([]),
    transport: 'none',
    roleAwarePrompting: false,
    consumesReferences: false,
  }),
  // A search, not a generation call -- reference images have nothing to attach to.
  pixabay: Object.freeze({
    maxReferences: 0,
    supportedRoles: Object.freeze([]),
    transport: 'none',
    roleAwarePrompting: false,
    consumesReferences: false,
  }),
  'local-safetensors': Object.freeze({
    maxReferences: 0,
    supportedRoles: Object.freeze([]),
    transport: 'none',
    roleAwarePrompting: false,
    consumesReferences: false,
  }),
});

function imageProviderCapabilities(provider) {
  const { provider: key } = parseImageProviderSelection(provider);
  const capabilities = IMAGE_PROVIDER_CAPABILITIES[key];
  if (!capabilities) throw new RangeError(`Unsupported image provider: ${provider}`);
  return capabilities;
}

function providerSlot(provider, index) {
  if (provider === 'gemini') return `contents.parts.reference[${index}]`;
  if (provider === 'openai') return `image[${index}]`;
  if (provider === 'dezgo') return 'init_image';
  return null;
}

function resolveImageReferencePlan(provider, references = []) {
  const { provider: key } = parseImageProviderSelection(provider);
  const capabilities = imageProviderCapabilities(key);
  const included = [];
  const excluded = [];

  for (const [candidateOrder, reference] of (Array.isArray(references) ? references : []).entries()) {
    const normalized = { ...reference, role: normalizeReferenceRole(reference?.role), candidateOrder };
    if (!capabilities.consumesReferences) {
      excluded.push({ ...normalized, reason: 'provider_does_not_consume_references' });
    } else if (!capabilities.supportedRoles.includes(normalized.role)) {
      excluded.push({ ...normalized, reason: 'unsupported_reference_role' });
    } else if (included.length >= capabilities.maxReferences) {
      excluded.push({ ...normalized, reason: 'provider_limit' });
    } else {
      const order = included.length;
      included.push({ ...normalized, order, providerSlot: providerSlot(key, order) });
    }
  }

  return { provider: key, capabilities, included, excluded };
}

module.exports = { IMAGE_PROVIDER_CAPABILITIES, imageProviderCapabilities, resolveImageReferencePlan };
