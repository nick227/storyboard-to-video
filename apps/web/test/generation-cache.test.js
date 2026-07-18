const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { GenerationCacheStore } = require('../src/storage/generation-cache-store');
const { createGenerationCacheService } = require('../src/services/generation-cache.service');
const { createPromptGenerationService } = require('../src/services/prompt-generation.service');
const { createDialogueService } = require('../src/services/dialogue.service');

function makeCache() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'generation-cache-'));
  const store = new GenerationCacheStore(root);
  const generationCache = createGenerationCacheService({ store });
  return { root, store, generationCache, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function countingProvider(responses) {
  let calls = 0;
  return {
    calls: () => calls,
    call: async () => { calls += 1; return responses.shift(); },
  };
}

const STYLE = { id: 'basic-cartoon', promptText: 'Ink style baseline' };
const SCENE = { id: 'scene-1', beat: 'Mara opens the door.', prompt: 'Mara opens the door, hallway beyond.', scriptFragment: 'Mara opens the door.', narrationText: '', narrationIsFallback: false };

test('prompt regenerate: identical input reuses the cached result with no second provider call', async () => {
  const { generationCache, cleanup } = makeCache();
  try {
    const provider = countingProvider([
      '{"prompt":"Mara opens the door, warm light spilling in."}',
      '{"prompt":"SHOULD NOT BE USED"}',
    ]);
    const service = createPromptGenerationService({ textProviders: provider, limits: { prompt: 20000 }, generationCache });
    const input = { scene: SCENE, sceneIndex: 0, style: STYLE, provider: 'gemini', tenantId: 'tenant-a' };

    const first = await service.regeneratePrompt(input);
    assert.equal(provider.calls(), 1);
    assert.equal(first.cacheHit, undefined);

    const second = await service.regeneratePrompt(input);
    assert.equal(provider.calls(), 1, 'identical input must not trigger a second provider call');
    assert.equal(second.cacheHit, true);
    assert.equal(second.prompt, first.prompt);
  } finally {
    cleanup();
  }
});

test('prompt regenerate: bypassCache forces a fresh provider call and preserves the earlier result', async () => {
  const { generationCache, store, cleanup } = makeCache();
  try {
    const provider = countingProvider([
      '{"prompt":"First variation of the prompt."}',
      '{"prompt":"Second variation of the prompt."}',
    ]);
    const service = createPromptGenerationService({ textProviders: provider, limits: { prompt: 20000 }, generationCache });
    const input = { scene: SCENE, sceneIndex: 0, style: STYLE, provider: 'gemini', tenantId: 'tenant-a' };

    const first = await service.regeneratePrompt(input);
    const second = await service.regeneratePrompt({ ...input, bypassCache: true });
    assert.equal(provider.calls(), 2, 'an explicit bypass must always call the provider again');
    assert.notEqual(second.prompt, first.prompt);

    // Variation history is preserved: a plain (non-bypass) lookup afterward can still find an
    // entry whose result equals the ORIGINAL first-call output somewhere in the cache history,
    // proving the bypass did not overwrite/destroy it.
    const fingerprint = require('../src/shared/fingerprint').computeFingerprint({
      tenantId: 'tenant-a', operation: 'prompt.regenerate', provider: 'gemini', promptTemplateVersion: 1,
      source: JSON.stringify({
        source: SCENE.scriptFragment,
        sceneIndex: 0,
        title: SCENE.title || '',
        beat: SCENE.beat,
        existingPrompt: SCENE.prompt,
        usedNarrationSource: false,
        narrationText: '',
        previousBeat: '',
        nextBeat: '',
        extraPromptText: undefined,
        styleId: STYLE.id,
        stylePromptText: STYLE.promptText,
        commonPromptText: undefined,
      }),
      settings: { enrich: true },
    });
    const allFilesForFingerprint = fs.readdirSync(store.root).filter((name) => name.startsWith(store.prefix('tenant-a', fingerprint.fingerprintHash)));
    const results = allFilesForFingerprint.map((name) => JSON.parse(fs.readFileSync(path.join(store.root, name), 'utf8')).result.prompt);
    assert.ok(results.includes(first.prompt), 'the pre-bypass result must still exist in cache history');
    assert.ok(results.includes(second.prompt), 'the bypassed fresh result must also exist in cache history');
  } finally {
    cleanup();
  }
});

test('prompt regenerate: cache is scoped per tenant — an identical fingerprint under a different tenant never hits', async () => {
  const { generationCache, cleanup } = makeCache();
  try {
    const provider = countingProvider([
      '{"prompt":"Tenant A prompt."}',
      '{"prompt":"Tenant B prompt."}',
    ]);
    const service = createPromptGenerationService({ textProviders: provider, limits: { prompt: 20000 }, generationCache });
    const inputA = { scene: SCENE, sceneIndex: 0, style: STYLE, provider: 'gemini', tenantId: 'tenant-a' };
    const inputB = { ...inputA, tenantId: 'tenant-b' };

    await service.regeneratePrompt(inputA);
    const resultB = await service.regeneratePrompt(inputB);
    assert.equal(provider.calls(), 2, 'a different tenant must never be served from another tenant\'s cache entry');
    assert.equal(resultB.cacheHit, undefined);
  } finally {
    cleanup();
  }
});

test('narration regenerate: identical input reuses the cached result; explicit bypass calls the provider again', async () => {
  const { generationCache, cleanup } = makeCache();
  try {
    const provider = countingProvider([
      '{"narrationText":"Mara steps through the doorway, hallway stretching ahead."}',
      '{"narrationText":"SHOULD NOT BE USED"}',
      '{"narrationText":"A different narration for the same scene."}',
    ]);
    const dialogue = createDialogueService({ textProviders: provider, generationCache });
    const scene = { ...SCENE };
    const input = { scene, sceneIndex: 0, provider: 'gemini', tenantId: 'tenant-a' };

    const first = await dialogue.regenerateNarration(input);
    assert.equal(provider.calls(), 1);
    const second = await dialogue.regenerateNarration(input);
    assert.equal(provider.calls(), 1, 'identical narration regenerate input must reuse the cached result');
    assert.equal(second.cacheHit, true);
    assert.equal(second.narrationText, first.narrationText);

    const third = await dialogue.regenerateNarration({ ...input, bypassCache: true });
    assert.equal(provider.calls(), 2, 'bypassCache must force a fresh provider call');
    assert.notEqual(third.narrationText, first.narrationText);
  } finally {
    cleanup();
  }
});

test('exact-input reuse never touches whitespace/punctuation meaning: differently-punctuated narration is NOT treated as identical', async () => {
  const { computeFingerprint } = require('../src/shared/fingerprint');
  const a = computeFingerprint({ tenantId: 't', operation: 'narration.regenerate', provider: 'gemini', promptTemplateVersion: 1, source: "Wait...\nDon't go." });
  const b = computeFingerprint({ tenantId: 't', operation: 'narration.regenerate', provider: 'gemini', promptTemplateVersion: 1, source: "Wait... Don't go." });
  assert.notEqual(a.fingerprintHash, b.fingerprintHash, 'a newline vs a space must not fingerprint identically — pacing/meaning must not be collapsed');
});

test('exact-input reuse still collapses harmless transport differences (surrounding whitespace, CRLF)', async () => {
  const { computeFingerprint } = require('../src/shared/fingerprint');
  const a = computeFingerprint({ tenantId: 't', operation: 'narration.regenerate', provider: 'gemini', promptTemplateVersion: 1, source: 'Hello there.' });
  const b = computeFingerprint({ tenantId: 't', operation: 'narration.regenerate', provider: 'gemini', promptTemplateVersion: 1, source: '  Hello there.\r\n' });
  assert.equal(a.fingerprintHash, b.fingerprintHash, 'surrounding whitespace / CRLF-vs-LF are harmless transport differences and should still be treated as identical');
});

test('cache invalidation on prompt-template version bump: identical input, bumped version, guaranteed miss', async () => {
  const { computeFingerprint } = require('../src/shared/fingerprint');
  const base = { tenantId: 't', operation: 'prompt.regenerate', provider: 'gemini', source: 'same source text' };
  const v1 = computeFingerprint({ ...base, promptTemplateVersion: 1 });
  const v2 = computeFingerprint({ ...base, promptTemplateVersion: 2 });
  assert.notEqual(v1.fingerprintHash, v2.fingerprintHash, 'bumping promptTemplateVersion must invalidate old cache entries for otherwise-identical input');
});

test('a cache hit writes its own audit row (servedFromEntryId) without creating a new provider-cost entry', async () => {
  const { generationCache, store, cleanup } = makeCache();
  try {
    const input = { tenantId: 'tenant-a', operation: 'prompt.regenerate', provider: 'gemini', promptTemplateVersion: 1, source: 'abc', settings: {} };
    const stored = await generationCache.record(input, { prompt: 'result A' });
    const hit = await generationCache.lookup(input);
    assert.ok(hit, 'lookup should find the previously stored entry');
    assert.equal(hit.result.prompt, 'result A');

    const files = fs.readdirSync(store.root).filter((name) => name.startsWith(store.prefix('tenant-a', require('../src/shared/fingerprint').computeFingerprint(input).fingerprintHash)));
    const rows = files.map((name) => JSON.parse(fs.readFileSync(path.join(store.root, name), 'utf8')));
    const hitRow = rows.find((row) => row.servedFromEntryId === stored.id);
    assert.ok(hitRow, 'the hit must be recorded as its own auditable row referencing the entry it reused');
    assert.equal(hitRow.bypassed, false);
  } finally {
    cleanup();
  }
});
