const crypto = require('node:crypto');

// Only harmless transport differences are canonicalized before hashing — trim the whole string and
// normalize line endings. Internal punctuation, ellipses, and paragraph/line breaks are hashed
// nearly verbatim, since for narration/TTS-facing text they carry pacing and meaning:
// "Wait...\nDon't go." must not fingerprint the same as "Wait... Don't go.". Callers are expected to
// have already assembled `source` into one string covering every field that actually affects the
// generation (e.g. via JSON.stringify of the relevant fields) — this function only does the final,
// minimal, meaning-preserving canonicalization on top of that.
function normalizeForFingerprint(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

// Deterministic fingerprint for exact-input reuse (see generation-cache.service.js). Every field
// that actually affects the generated output must be included by the caller — `promptTemplateVersion`
// exists specifically so a caller can invalidate old cache entries by bumping it whenever the
// underlying prompt/rules text changes, without needing to touch anything else.
function computeFingerprint({ tenantId, operation, provider, model, promptTemplateVersion, source, settings }) {
  const normalizedSource = normalizeForFingerprint(source);
  const canonical = JSON.stringify({
    tenantId,
    operation,
    provider,
    model: model || null,
    promptTemplateVersion,
    source: normalizedSource,
    settings: settings || {},
  });
  return {
    fingerprintHash: crypto.createHash('sha256').update(canonical).digest('hex'),
    sourceDigest: crypto.createHash('sha256').update(normalizedSource).digest('hex'),
  };
}

module.exports = { computeFingerprint, normalizeForFingerprint };
