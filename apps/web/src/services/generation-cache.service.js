const { computeFingerprint } = require('../shared/fingerprint');

// Exact-input reuse cache — LLM text outputs only (narration regenerate, visual-prompt regenerate,
// physical-action regenerate). Distinct from the idempotency-key mechanism (middleware/idempotency.js),
// which exists purely for safe retries of an in-flight/just-submitted request: a deterministic
// Idempotency-Key tied only to body content would replay an old response indefinitely whenever a
// user legitimately reruns the same inputs later, which is not what this is for. This cache is keyed
// by a fingerprint of the true generation inputs and is checked once, inside the already-authorized
// and validated request path (auth/tenant/project ownership and schema validation happen in
// middleware before a service function is ever called) — a cache hit never substitutes for or
// bypasses any authorization step.
function createGenerationCacheService({ store }) {
  // Cache hit: returns the prior successful result, and — even though this creates no new provider
  // call and no billing reservation — still writes its own row so every served request stays
  // traceable (which entry was reused, when). Returns null on a miss; callers proceed to call the
  // provider and then `record(...)` the fresh result themselves.
  async function lookup(input) {
    const { fingerprintHash, sourceDigest } = computeFingerprint(input);
    const entry = await store.lookup(input.tenantId, fingerprintHash);
    if (!entry) return null;
    await store.store({
      tenantId: input.tenantId,
      operation: input.operation,
      fingerprintHash,
      provider: input.provider,
      model: input.model || null,
      promptTemplateVersion: input.promptTemplateVersion,
      sourceDigest,
      result: entry.result,
      bypassed: false,
      servedFromEntryId: entry.id,
    });
    return entry;
  }

  // Records a freshly-generated result. `bypassed: true` marks a row created because the user
  // explicitly requested a new variation (skipping `lookup` entirely) rather than because no cached
  // result existed — the distinction that will later explain why two apparently-identical requests
  // produced two separate provider charges. Always writes a NEW row (append-only per
  // tenantId+fingerprintHash) — never overwrites a prior entry, so an explicit bypass can't destroy
  // a still-reusable earlier result.
  async function record(input, result, { bypassed = false } = {}) {
    const { fingerprintHash, sourceDigest } = computeFingerprint(input);
    return store.store({
      tenantId: input.tenantId,
      operation: input.operation,
      fingerprintHash,
      provider: input.provider,
      model: input.model || null,
      promptTemplateVersion: input.promptTemplateVersion,
      sourceDigest,
      result,
      bypassed,
      servedFromEntryId: null,
    });
  }

  async function runCached({ tenantId, operation, provider, promptTemplateVersion, source, settings, bypassCache, generateFn }) {
    const fingerprintInput = tenantId ? {
      tenantId, operation, provider, promptTemplateVersion,
      source: typeof source === 'string' ? source : JSON.stringify(source),
      settings,
    } : null;
    if (fingerprintInput && !bypassCache) {
      const cached = await lookup(fingerprintInput);
      if (cached) {
        // Planned narration is cached as a string and sequence/shot plans are cached as arrays.
        // Spreading either into an object destroys its type (and later turns a narration string
        // into "[object Object]"). Only object-shaped API responses can carry this diagnostic flag.
        if (cached.result && typeof cached.result === 'object' && !Array.isArray(cached.result)) {
          return { ...cached.result, cacheHit: true };
        }
        return cached.result;
      }
    }
    const result = await generateFn();
    if (fingerprintInput) {
      await record(fingerprintInput, result, { bypassed: bypassCache });
    }
    return result;
  }

  return { lookup, record, runCached };
}

module.exports = { createGenerationCacheService };
