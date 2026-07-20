const { z } = require('zod');
const { VIDEO_PROVIDERS } = require('./shared/video-provider-capabilities');

const projectId = z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const fallbackPolicy = z.enum(['fail', 'local']).default('local');
const projectDocument = z.object({
  id: projectId.optional(),
  title: z.string().trim().max(200).default('Untitled'),
  scenes: z.array(z.record(z.any())).max(50).default([]),
}).passthrough();

const createProject = z.object({
  id: projectId.optional(),
  title: z.string().trim().min(1).max(200).default('Untitled'),
  project: projectDocument.optional(),
}).default({});

const regeneratePrompt = z.object({
  projectId,
  scene: z.record(z.any()),
  sceneIndex: z.coerce.number().int().min(0).max(49).default(0),
  previousBeat: z.string().max(2_000).default(''),
  nextBeat: z.string().max(2_000).default(''),
  styleId: z.string().trim().min(1).max(80).default('basic-cartoon'),
  commonPromptText: z.string().max(20_000).default(''),
  provider: z.enum(['gemini', 'openai', 'stub']).default('gemini'),
  extraPromptText: z.string().max(20_000).default(''),
  fallbackPolicy,
  scriptText: z.string().max(200_000).default(''),
  enrich: z.boolean().default(true),
  // When true, skip the exact-input reuse cache lookup unconditionally (an explicit "generate a new
  // variation" request) — the fresh result is still recorded afterward. See generation-cache.service.js.
  bypassCache: z.boolean().default(false),
});

// Narration-driven planning: no sceneCount here by design -- shot count is never guessed upfront,
// it falls out of how many shots the AI actually plans from the finalized narration. See
// shot-planning.service.js.
const planShots = z.object({
  projectId,
  scriptText: z.string().trim().min(1).max(200_000),
  styleId: z.string().trim().min(1).max(80).default('basic-cartoon'),
  commonPromptText: z.string().max(20_000).default(''),
  provider: z.enum(['gemini', 'openai', 'stub']).default('gemini'),
  fallbackPolicy,
  enrich: z.boolean().default(true),
  // A ceiling, not a target -- shot count still emerges from planning. Omitted/undefined means
  // uncapped. See shot-planning.service.js for how this is passed to the model as guidance and
  // only hard-enforced by a final deterministic merge if the model doesn't land within it.
  maxShots: z.coerce.number().int().min(1).max(200).optional(),
  bypassCache: z.boolean().default(false),
});

const splitScene = z.object({
  projectId,
  scriptFragment: z.string().trim().min(1).max(20_000),
  // Keep this max in sync with MAX_SPLIT_COUNT in apps/web/public/modules/scene-count.js — the
  // frontend clamps every split request to that same value before it ever reaches this schema.
  count: z.coerce.number().int().min(2).max(8).default(2),
  // The scene's real (non-fallback) narration, if it has any — only sent when Enrich is on and the
  // scene has real narration. The split service preserves this verbatim across the children rather
  // than regenerating it; see scene-split.service.js.
  narrationText: z.string().trim().max(6_000).default(''),
  provider: z.enum(['gemini', 'openai', 'stub']).default('gemini'),
  fallbackPolicy,
});

const regenerateAction = z.object({
  projectId,
  scene: z.record(z.any()),
  sceneIndex: z.coerce.number().int().min(0).max(49).default(0),
  previousBeat: z.string().max(2_000).default(''),
  nextBeat: z.string().max(2_000).default(''),
  provider: z.enum(['gemini', 'openai', 'stub']).default('gemini'),
  fallbackPolicy,
  scriptText: z.string().max(200_000).default(''),
  bypassCache: z.boolean().default(false),
});

const exportProject = z.object({
  projectId,
});

const sceneId = z.string().trim().min(1).max(120);

const aspectRatio = z.enum(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']);
const resolutionTier = z.enum(['draft', 'standard', 'high', 'ultra']);
const mediaSettings = z.object({
  version: z.literal(1).default(1),
  aspectRatio,
  image: z.object({ resolutionTier, quality: z.enum(['low', 'medium', 'high']) }),
  video: z.object({ resolutionTier, durationSeconds: z.coerce.number().positive().max(300).optional() }),
});

const imageGeneration = z.object({
  projectId,
  sceneId,
  sceneNumber: z.coerce.number().int().min(1).max(50).default(1),
  sceneTitle: z.string().max(200).default(''),
  scenePrompt: z.string().trim().min(1).max(20_000),
  styleId: z.string().trim().min(1).max(80).default('basic-cartoon'),
  commonPromptText: z.string().max(20_000).default(''),
  extraPromptText: z.string().max(20_000).default(''),
  provider: z.enum(['gemini', 'openai', 'dezgo', 'stub']).default('gemini'),
  confirmedReferencePlanHash: z.string().trim().max(80).optional(),
  outputIntent: z.object({
    aspectRatio: aspectRatio.optional(),
    resolutionTier: resolutionTier.optional(),
    quality: z.enum(['low', 'medium', 'high']).optional(),
  }).optional(),
});

const videoGeneration = z.object({
  projectId,
  sceneId,
  sceneNumber: z.coerce.number().int().min(1).max(50).default(1),
  sceneTitle: z.string().max(200).default(''),
  scenePrompt: z.string().max(20_000).default(''),
  sceneBeat: z.string().max(20_000).default(''),
  styleId: z.string().trim().min(1).max(80).default('basic-cartoon'),
  commonPromptText: z.string().max(20_000).default(''),
  motionPrompt: z.string().max(4_000).default(''),
  motionIntensity: z.enum(['subtle', 'medium', 'high']).default('medium'),
  imagePath: z.string().trim().min(1).max(500).optional(),
  provider: z.enum(VIDEO_PROVIDERS).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  generationMode: z.enum(['image_to_video']).optional(),
  outputIntent: z.object({
    durationSeconds: z.coerce.number().positive().max(300).optional(),
    aspectRatio: aspectRatio.optional(),
    resolutionTier: resolutionTier.optional(),
    audioPolicy: z.enum(['none', 'provider_native', 'replace_with_project_audio']).optional(),
    seed: z.coerce.number().int().min(0).max(2 ** 31 - 1).optional(),
    providerOptions: z.object({ version: z.literal(1), values: z.record(z.string(), z.unknown()) }).optional(),
  }).optional(),
});

const subtitleGeneration = z.object({
  projectId,
  sceneId,
  sceneNumber: z.coerce.number().int().min(1).max(50).default(1),
  sceneTitle: z.string().max(200).default(''),
  // Cosmetic overlay preset only -- unrelated to `styleId` (the visual art style used for
  // image/video generation elsewhere). Never affects alignment/cue-grouping logic.
  captionStyle: z.enum(['classic', 'bold', 'minimal']).default('classic'),
});

const narratorVoice = z.object({ voiceId: z.string(), label: z.string().optional() }).nullable().default(null);
const audioGeneration = z.object({
  projectId,
  sceneId,
  sceneNumber: z.coerce.number().int().min(1).max(50).default(1),
  sceneTitle: z.string().max(200).default(''),
  narrationText: z.string().trim().min(1).max(6_000),
  provider: z.enum(['elevenlabs', 'piper', 'spark', 'stub']).default('stub'),
  voice: narratorVoice,
});

const regenerateDialogue = z.object({
  projectId,
  scene: z.record(z.any()),
  sceneIndex: z.coerce.number().int().min(0).max(49).default(0),
  instruction: z.string().max(500).default(''),
  provider: z.enum(['gemini', 'openai', 'stub']).default('gemini'),
  fallbackPolicy,
  enrich: z.boolean().default(true),
  bypassCache: z.boolean().default(false),
});

module.exports = { audioGeneration, createProject, exportProject, fallbackPolicy, imageGeneration, mediaSettings, planShots, projectDocument, projectId, regenerateAction, regenerateDialogue, regeneratePrompt, splitScene, subtitleGeneration, videoGeneration };
