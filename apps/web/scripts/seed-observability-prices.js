require('dotenv').config();

const crypto = require('node:crypto');
const { loadConfig } = require('../src/config/env');
const { createPrismaClient } = require('../src/storage/prisma-client');

// Non-billable ProviderPriceVersion rows for providers/models that have real generation history
// but never had a formal price -- their cost only ever existed in a hand-maintained JS estimator
// (now removed). None of these set billable:true; that stays reserved for prices that have gone
// through real dashboard reconciliation (currently just openai/text/gpt-4.1-mini).
const ROWS = [
  {
    versionKey: 'minimax-hailuo-02-2026-observability-v1', provider: 'minimax', modality: 'video', model: 'MiniMax-Hailuo-02',
    rateCard: { type: 'flat', quantityKey: 'videos', nanoUsdPerUnit: 270_000_000 },
    reservationNanoUsd: 300_000_000n,
    sourceReference: 'https://fal.ai/models/fal-ai/minimax/hailuo-02/standard/image-to-video',
    reconciliationNotes: 'Estimated from fal.ai\'s published Hailuo-02 Standard (768p) rate of ~$0.045/sec for a typical ~6s generation ($0.27/video); this app calls MiniMax directly, so the real per-account rate may differ. Placeholder pending dashboard reconciliation.',
  },
  {
    versionKey: 'ltx-video-observability-v1', provider: 'ltx', modality: 'video', model: 'ltx-video',
    rateCard: { type: 'flat', quantityKey: 'videos', nanoUsdPerUnit: 15_000_000 },
    reservationNanoUsd: 20_000_000n,
    sourceReference: null,
    reconciliationNotes: 'Carried over exactly from the previous hardcoded estimator ($0.015/generation, ~5s at 24fps) -- a prior rough estimate of the self-hosted Modal.com A100 GPU cost, not a vendor invoice. Placeholder pending real Modal billing reconciliation.',
  },
  {
    versionKey: 'piper-local-observability-v1', provider: 'piper', modality: 'audio', model: 'piper-local',
    rateCard: { type: 'linear_steps', usageKey: 'seconds', baseNanoUsd: 10_000_000, baseUnits: 100 },
    reservationNanoUsd: 15_000_000n,
    sourceReference: null,
    reconciliationNotes: 'Carried over exactly from the previous hardcoded estimator ($0.01 per 100 seconds of audio). Placeholder pending real Modal/local compute cost reconciliation.',
  },
  {
    versionKey: 'piper-modal-observability-v1', provider: 'piper', modality: 'audio', model: 'piper-modal',
    rateCard: { type: 'linear_steps', usageKey: 'seconds', baseNanoUsd: 10_000_000, baseUnits: 100 },
    reservationNanoUsd: 15_000_000n,
    sourceReference: null,
    reconciliationNotes: 'Same estimate as piper-local; seeded separately since production sets PIPER_SERVICE_URL (Modal-hosted) and records this model name, while this dev DB has so far only ever recorded piper-local.',
  },
  {
    versionKey: 'spark-tts-observability-v1', provider: 'spark', modality: 'audio', model: 'spark-tts',
    rateCard: { type: 'linear_steps', usageKey: 'seconds', baseNanoUsd: 50_000_000, baseUnits: 100 },
    reservationNanoUsd: 60_000_000n,
    sourceReference: null,
    reconciliationNotes: 'Carried over exactly from the previous hardcoded estimator ($0.05 per 100 seconds of audio). Placeholder pending real Modal compute cost reconciliation.',
  },
  {
    versionKey: 'spark-voice-clone-observability-v1', provider: 'spark', modality: 'audio', model: 'spark-voice-clone',
    rateCard: { type: 'flat', quantityKey: 'clones', nanoUsdPerUnit: 500_000_000 },
    reservationNanoUsd: 600_000_000n,
    sourceReference: null,
    reconciliationNotes: 'New placeholder (this operation was previously untracked entirely). Voice cloning is a distinct, likely GPU-heavier Modal job than a single TTS synthesis call; $0.50/clone is a rough order-of-magnitude guess pending real reconciliation.',
  },
  {
    versionKey: 'spark-preflight-observability-v1', provider: 'spark', modality: 'audio', model: 'spark-preflight',
    rateCard: { type: 'flat', nanoUsdPerUnit: 0 },
    reservationNanoUsd: 0n,
    sourceReference: null,
    reconciliationNotes: 'New placeholder (this operation was previously untracked entirely). A lightweight health-check ping against the Modal container; assumed negligible compute, not a GPU inference call.',
  },
  {
    versionKey: 'spark-reference-observability-v1', provider: 'spark', modality: 'audio', model: 'spark-reference',
    rateCard: { type: 'flat', nanoUsdPerUnit: 0 },
    reservationNanoUsd: 0n,
    sourceReference: null,
    reconciliationNotes: 'New placeholder (this operation was previously untracked entirely). Reads pre-stored reference audio for a cloned voice; assumed negligible cost, not a GPU inference call.',
  },
  {
    versionKey: 'whisperx-forced-alignment-observability-v1', provider: 'whisperx', modality: 'alignment', model: 'whisperx-forced-alignment',
    rateCard: { type: 'flat', nanoUsdPerUnit: 2_000_000 },
    reservationNanoUsd: 3_000_000n,
    sourceReference: null,
    reconciliationNotes: 'New placeholder (this service was previously entirely untracked). No public per-call price exists for this self-hosted WhisperX forced-alignment service; $0.002/call is a rough guess at typical Modal GPU-second cost for a short clip. Placeholder pending real reconciliation.',
  },
];

async function main() {
  const config = loadConfig();
  const prisma = createPrismaClient(config.env.DATABASE_URL);
  try {
    for (const row of ROWS) {
      const existing = await prisma.providerPriceVersion.findUnique({ where: { versionKey: row.versionKey } });
      if (existing) { console.log(`already exists: ${row.versionKey}`); continue; }
      const created = await prisma.providerPriceVersion.create({ data: {
        id: crypto.randomUUID(), versionKey: row.versionKey, provider: row.provider, modality: row.modality, model: row.model,
        currency: 'USD', rateCard: row.rateCard, reservationNanoUsd: row.reservationNanoUsd,
        evidenceStatus: 'estimated', reconciledAt: new Date(), reconciliationNotes: row.reconciliationNotes, sourceReference: row.sourceReference,
        billable: false, active: true,
      } });
      console.log(`created ${created.versionKey}: ${created.provider}/${created.modality}/${created.model}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
