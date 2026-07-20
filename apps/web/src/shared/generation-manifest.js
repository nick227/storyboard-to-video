const MANIFEST_SCHEMA_VERSION = 1;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().flatMap((key) => (
      value[key] === undefined ? [] : [[key, canonicalize(value[key])]]
    )));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

// FNV-1a 64 is used as a deterministic change detector, not as a security primitive. It is small
// enough to run synchronously in both Node and the browser, which keeps stage-status derivation pure.
function hashCanonical(value) {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

function createGenerationManifest({ modality, inputs, result = {}, omissions = [], createdAt = new Date().toISOString() }) {
  const frozenInputs = canonicalize({ modality, ...inputs });
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    manifestHash: hashCanonical(frozenInputs),
    createdAt,
    inputs: frozenInputs,
    result: canonicalize(result),
    omissions: canonicalize(omissions),
  };
}

module.exports = { MANIFEST_SCHEMA_VERSION, canonicalJson, createGenerationManifest, hashCanonical };
