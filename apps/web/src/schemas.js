const { z } = require('zod');

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

const promptGeneration = z.object({
  projectId,
  scriptText: z.string().trim().min(1).max(200_000),
  sceneCount: z.coerce.number().int().min(1).max(50).default(6),
  styleId: z.string().trim().min(1).max(80).default('basic-cartoon'),
  commonPromptText: z.string().max(20_000).default(''),
  provider: z.enum(['gemini', 'openai', 'stub']).default('gemini'),
  fallbackPolicy,
});

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
});

const exportProject = z.object({
  projectId,
});

const sceneId = z.string().trim().min(1).max(120);

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
  imagePath: z.string().trim().min(1).max(500),
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

const dialogueScene = z.object({
  sceneNumber: z.coerce.number().int().min(1).max(50).default(1),
  title: z.string().max(200).default(''),
  beat: z.string().max(2_000).default(''),
  scriptFragment: z.string().max(20_000).default(''),
});

const generateDialogue = z.object({
  projectId,
  scenes: z.array(dialogueScene).min(1).max(50),
  provider: z.enum(['gemini', 'openai', 'stub']).default('gemini'),
  fallbackPolicy,
});

const regenerateDialogue = z.object({
  projectId,
  scene: z.record(z.any()),
  sceneIndex: z.coerce.number().int().min(0).max(49).default(0),
  instruction: z.string().max(500).default(''),
  provider: z.enum(['gemini', 'openai', 'stub']).default('gemini'),
  fallbackPolicy,
});

module.exports = { audioGeneration, createProject, exportProject, fallbackPolicy, generateDialogue, imageGeneration, projectDocument, projectId, promptGeneration, regenerateAction, regenerateDialogue, regeneratePrompt, videoGeneration };
