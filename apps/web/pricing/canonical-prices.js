// Canonical provider/model prices — one active row per provider+modality+model.
// Billing keys off the configured model name (env), not provider snapshot model IDs.
//
// Keeping costs current (operators, not admin UI):
// 1. When a vendor changes public pricing, update rateCard + reservationNanoUsd here.
// 2. Bump versionKey if rate_card inputs changed (rows are immutable once inserted).
// 3. Run: node scripts/seed-canonical-pricing.js --apply
// 4. Optionally run scripts/reconcile-openai-text-price.js (or similar) for dashboard evidence.
// 5. Verify margins in Admin → Generations; toggle billable per model in Admin → Pricing.
const RECONCILED_AT = new Date('2026-07-17T12:00:00.000Z');

const CANONICAL_PRICES = [
  {
    versionKey: 'openai-gpt-4.1-mini-2026-07-17',
    provider: 'openai', modality: 'text', model: 'gpt-4.1-mini',
    rateCard: { type: 'token_components', components: [
      { usageKey: 'inputTokens', subtractUsageKey: 'cachedInputTokens', nanoUsdPerMillion: 400_000_000 },
      { usageKey: 'cachedInputTokens', nanoUsdPerMillion: 100_000_000 },
      { usageKey: 'outputTokens', nanoUsdPerMillion: 1_600_000_000 },
    ] },
    reservationNanoUsd: 50_000_000n,
    sourceReference: 'https://developers.openai.com/api/docs/pricing',
    reconciliationNotes: 'OpenAI public API pricing captured 2026-07-17.',
  },
  {
    versionKey: 'openai-gpt-image-1-2026-07-17',
    provider: 'openai', modality: 'image', model: 'gpt-image-1',
    rateCard: { type: 'token_components', components: [
      { usageKey: 'inputTextTokens', nanoUsdPerMillion: 5_000_000_000 },
      { usageKey: 'inputImageTokens', nanoUsdPerMillion: 10_000_000_000 },
      { usageKey: 'outputImageTokens', nanoUsdPerMillion: 40_000_000_000 },
    ] },
    reservationNanoUsd: 50_000_000n,
    sourceReference: 'https://developers.openai.com/api/docs/guides/image-generation#calculating-costs',
    reconciliationNotes: 'OpenAI image token pricing captured 2026-07-17.',
  },
  {
    versionKey: 'gemini-3.5-flash-2026-07-17',
    provider: 'gemini', modality: 'text', model: 'gemini-3.5-flash',
    rateCard: { type: 'token_components', components: [
      { usageKey: 'inputTokens', nanoUsdPerMillion: 1_500_000_000 },
      { usageKey: 'outputTokens', nanoUsdPerMillion: 9_000_000_000 },
    ] },
    reservationNanoUsd: 100_000_000n,
    sourceReference: 'https://ai.google.dev/gemini-api/docs/pricing',
    reconciliationNotes: 'Gemini public pricing captured 2026-07-17.',
  },
  {
    versionKey: 'gemini-3.1-flash-image-2026-07-17',
    provider: 'gemini', modality: 'image', model: 'gemini-3.1-flash-image',
    rateCard: { type: 'token_components', components: [
      { usageKey: 'inputTokens', nanoUsdPerMillion: 500_000_000 },
      { usageKey: 'outputTextOrThinkingTokens', nanoUsdPerMillion: 3_000_000_000 },
      { usageKey: 'outputImageTokens', nanoUsdPerMillion: 60_000_000_000 },
    ] },
    reservationNanoUsd: 100_000_000n,
    sourceReference: 'https://ai.google.dev/gemini-api/docs/pricing',
    reconciliationNotes: 'Gemini image token pricing captured 2026-07-17.',
  },
  {
    versionKey: 'dezgo-text2image-2026-07-17',
    provider: 'dezgo', modality: 'image', model: 'text2image',
    rateCard: { type: 'linear_steps', usageKey: 'steps', quantityKey: 'images', baseNanoUsd: 18_100_000, baseUnits: 30 },
    reservationNanoUsd: 20_000_000n,
    sourceReference: 'https://dev.dezgo.com/pricing/sd1/',
    reconciliationNotes: 'Dezgo SD1 linear steps pricing; validated against account transaction 2026-07-17.',
  },
  {
    versionKey: 'minimax-hailuo-02-2026-observability-v1',
    provider: 'minimax', modality: 'video', model: 'MiniMax-Hailuo-02',
    rateCard: { type: 'flat', quantityKey: 'videos', nanoUsdPerUnit: 270_000_000 },
    reservationNanoUsd: 300_000_000n,
    reconciliationNotes: 'Estimated ~$0.27/video for typical 6s clip; pending vendor invoice reconciliation.',
  },
  {
    versionKey: 'ltx-video-observability-v1',
    provider: 'ltx', modality: 'video', model: 'ltx-video',
    rateCard: { type: 'flat', quantityKey: 'videos', nanoUsdPerUnit: 15_000_000 },
    reservationNanoUsd: 20_000_000n,
    reconciliationNotes: 'Self-hosted LTX estimate ~$0.015/generation.',
  },
  {
    versionKey: 'piper-local-observability-v1',
    provider: 'piper', modality: 'audio', model: 'piper-local',
    rateCard: { type: 'linear_steps', usageKey: 'seconds', baseNanoUsd: 10_000_000, baseUnits: 100 },
    reservationNanoUsd: 15_000_000n,
    reconciliationNotes: 'Local Piper TTS estimate $0.01 per 100 seconds.',
  },
  {
    versionKey: 'piper-modal-observability-v1',
    provider: 'piper', modality: 'audio', model: 'piper-modal',
    rateCard: { type: 'linear_steps', usageKey: 'seconds', baseNanoUsd: 10_000_000, baseUnits: 100 },
    reservationNanoUsd: 15_000_000n,
    reconciliationNotes: 'Modal-hosted Piper estimate $0.01 per 100 seconds.',
  },
  {
    versionKey: 'spark-tts-observability-v1',
    provider: 'spark', modality: 'audio', model: 'spark-tts',
    rateCard: { type: 'linear_steps', usageKey: 'seconds', baseNanoUsd: 50_000_000, baseUnits: 100 },
    reservationNanoUsd: 60_000_000n,
    reconciliationNotes: 'Spark TTS estimate $0.05 per 100 seconds.',
  },
  {
    versionKey: 'spark-voice-clone-observability-v1',
    provider: 'spark', modality: 'audio', model: 'spark-voice-clone',
    rateCard: { type: 'flat', quantityKey: 'clones', nanoUsdPerUnit: 500_000_000 },
    reservationNanoUsd: 600_000_000n,
    reconciliationNotes: 'Voice clone GPU job estimate ~$0.50/clone.',
  },
  {
    versionKey: 'spark-preflight-observability-v1',
    provider: 'spark', modality: 'audio', model: 'spark-preflight',
    rateCard: { type: 'flat', nanoUsdPerUnit: 0 },
    reservationNanoUsd: 0n,
    reconciliationNotes: 'Health-check ping; negligible cost.',
  },
  {
    versionKey: 'spark-reference-observability-v1',
    provider: 'spark', modality: 'audio', model: 'spark-reference',
    rateCard: { type: 'flat', nanoUsdPerUnit: 0 },
    reservationNanoUsd: 0n,
    reconciliationNotes: 'Reference audio read; negligible cost.',
  },
  {
    versionKey: 'whisperx-forced-alignment-observability-v1',
    provider: 'whisperx', modality: 'alignment', model: 'whisperx-forced-alignment',
    rateCard: { type: 'flat', nanoUsdPerUnit: 2_000_000 },
    reservationNanoUsd: 3_000_000n,
    reconciliationNotes: 'WhisperX forced-alignment estimate ~$0.002/call.',
  },
];

function priceKey(row) { return `${row.provider}::${row.modality}::${row.model}`; }

module.exports = { CANONICAL_PRICES, RECONCILED_AT, priceKey };
