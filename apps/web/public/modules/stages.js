import { api, cancelActiveProjectJobs } from './api.js';
import { sceneStore, uiStore, projectStore, batchStore, voiceStore, generationStore, spendStore } from './store.js';
import { refreshCreditBalance } from './credit-balance.js';
import { regeneratePrompt, planShots, regenerateImage, regenerateAudio, regenerateVideo, regenerateSubtitles } from './workflows.js';
import { batchController } from './batch.js';
import { ensureProjectSynced, getCurrentStoryboardRecord, queueSync } from './persistence.js';
import { imageShot } from './scene-shots.js';
import { hashCanonical } from './generation-manifest.js';
import { normalizeReferenceRole } from './reference-roles.js';
import { resolveImageReferencePlan } from './image-reference-plan.js';

// --- Staleness -------------------------------------------------------------

function additionalCommonPrompt(stylePrompt, commonPrompt) {
  const style = String(stylePrompt || '').trim();
  const common = String(commonPrompt || '').trim();
  if (!style || !common) return common;
  if (common === style) return '';
  return common.startsWith(style) ? common.slice(style.length).trim() : common;
}

function currentStyle(record) {
  return generationStore.get().styles.find((style) => style.id === record?.styleId) || null;
}

function currentImageReferences(scene, provider, styleId) {
  const generation = generationStore.get();
  if (generation.styleReferencesStyleId !== styleId) return null;
  const shot = imageShot(scene);
  const uploaded = (shot.referenceBindings || []).map((reference) => ({
    path: reference.path,
    source: 'scene',
    role: normalizeReferenceRole(reference.role),
  })).filter((reference) => Boolean(reference.path));
  const disabled = new Set(shot.disabledStyleReferencePaths || []);
  const styleReferences = [
    ...(generation.styleReferences?.characters || []).slice(0, 4),
    ...(generation.styleReferences?.world || []).slice(0, 4),
  ].slice(0, 8).filter((reference) => !disabled.has(reference.url)).map((reference) => ({
    path: reference.url,
    source: 'style',
    role: reference.type === 'characters' ? 'character' : reference.type === 'world' ? 'location' : 'composition',
  }));
  return resolveImageReferencePlan(provider, [...uploaded, ...styleReferences]).included.map((reference) => ({
    path: reference.path,
    source: reference.source,
    role: reference.role,
    order: reference.order,
    providerSlot: reference.providerSlot,
    consumed: true,
  }));
}

function manifestStaleness(version, currentInputs) {
  const manifest = version?.manifest;
  if (!manifest?.inputs || !manifest?.manifestHash || !currentInputs) return null;
  if (hashCanonical(manifest.inputs) !== manifest.manifestHash) return true;
  return hashCanonical(currentInputs) !== manifest.manifestHash;
}

function imageManifestStaleness(scene, shot, version) {
  const record = getCurrentStoryboardRecord();
  const style = currentStyle(record);
  if (!record || !style || !version?.manifest?.inputs) return null;
  if (record.mediaSettings && version.output?.requested) {
    const requested = {
      ...(record.mediaSettings.aspectRatio ? { aspectRatio: record.mediaSettings.aspectRatio } : {}),
      ...(record.mediaSettings.image?.resolutionTier ? { resolutionTier: record.mediaSettings.image.resolutionTier } : {}),
      ...(record.mediaSettings.image?.quality ? { quality: record.mediaSettings.image.quality } : {}),
    };
    if (Object.entries(requested).some(([key, value]) => version.output.requested[key] !== value)) return true;
  }
  const references = currentImageReferences(scene, record.imageProvider, record.styleId);
  if (!references) return null;
  const inputs = structuredClone(version.manifest.inputs);
  inputs.prompt = {
    ...(inputs.prompt || {}),
    scene: shot.prompt || '',
    style: style.promptText || '',
    common: additionalCommonPrompt(style.promptText, record.commonPromptText),
  };
  inputs.style = { ...(inputs.style || {}), id: record.styleId };
  inputs.provider = { ...(inputs.provider || {}), name: record.imageProvider };
  inputs.references = references;
  return manifestStaleness(version, inputs);
}

function videoManifestStaleness(scene, shot, activeImage, version) {
  const record = getCurrentStoryboardRecord();
  const style = currentStyle(record);
  if (!record || !style || !version?.manifest?.inputs) return null;
  if (record.mediaSettings && version.output?.requested) {
    const requested = {
      ...(record.mediaSettings.aspectRatio ? { aspectRatio: record.mediaSettings.aspectRatio } : {}),
      ...(record.mediaSettings.video?.resolutionTier ? { resolutionTier: record.mediaSettings.video.resolutionTier } : {}),
      ...(record.mediaSettings.video?.durationSeconds ? { durationSeconds: record.mediaSettings.video.durationSeconds } : {}),
    };
    if (Object.entries(requested).some(([key, value]) => version.output.requested[key] !== value)) return true;
  }
  const inputs = structuredClone(version.manifest.inputs);
  inputs.prompt = {
    ...(inputs.prompt || {}),
    scene: shot.prompt || '',
    beat: scene.beat || '',
    style: style.promptText || '',
    common: additionalCommonPrompt(style.promptText, record.commonPromptText),
  };
  inputs.style = { ...(inputs.style || {}), id: record.styleId };
  inputs.settings = { ...(inputs.settings || {}), motionIntensity: record.videoMotionIntensity || 'medium' };
  const confirmedKeyframes = shot.videoKeyframeSelection?.source === 'video_generation_confirmation'
    && shot.videoKeyframeSelection.startFrame === shot.startFrame
    && (shot.videoKeyframeSelection.endFrame || null) === (shot.endFrame || null)
    ? shot.videoKeyframeSelection
    : null;
  const startFramePath = confirmedKeyframes?.startFrame || activeImage?.path || '';
  const frameInput = (role, selectedPath) => {
    const stored = (inputs.sourceAssets || []).find((asset) => asset?.role === role) || {};
    return {
      ...stored,
      role,
      path: selectedPath,
      ...(stored.sha256 !== undefined ? { sha256: stored.path === selectedPath ? stored.sha256 : null } : {}),
    };
  };
  inputs.sourceAssets = [
    frameInput('start_frame', startFramePath),
    ...(confirmedKeyframes?.endFrame ? [frameInput('end_frame', confirmedKeyframes.endFrame)] : []),
  ];
  return manifestStaleness(version, inputs);
}

// New image/video versions use immutable generation manifests and canonical input hashes. Legacy
// versions retain the older field comparisons below, while audio/subtitle still use their existing
// server-authored provenance snapshots.
export function computeStaleness(scene) {
  const shot = imageShot(scene);
  const activeImage = (shot.versions || [])[shot.activeVersionIndex] || null;
  const activeAudio = (scene.audioVersions || [])[scene.activeAudioVersionIndex] || null;
  const activeVideo = (shot.videoVersions || [])[shot.activeVideoVersionIndex] || null;
  const activeSubtitle = (scene.subtitleVersions || [])[scene.activeSubtitleVersionIndex] || null;

  const hasPrompt = Boolean(String(scene.prompt || '').trim());
  const promptStale = hasPrompt && (
    String(scene.beat || '') !== String(scene.promptGeneratedFromBeat || '') ||
    (scene.promptGeneratedFromNarration != null && String(scene.narrationText || '') !== String(scene.promptGeneratedFromNarration))
  );

  // Compare against `scenePrompt` (the raw scene-level prompt), not `prompt` — the version's
  // `prompt` field is the full composed provider prompt (style + common + scene + extra) and can
  // never equal `scene.prompt` alone, which would make every image read as permanently stale. The
  // provider check only applies when the version actually recorded one — versions created before
  // this field existed have `provider: undefined` and must not all be mass-marked stale on upgrade.
  const imageManifestStale = imageManifestStaleness(scene, shot, activeImage);
  const imageStale = Boolean(activeImage?.path) && (imageManifestStale ?? (
    String(activeImage.scenePrompt || '') !== String(shot.prompt || '') ||
    (Boolean(activeImage.provider) && String(activeImage.provider) !== String(getCurrentStoryboardRecord()?.imageProvider || ''))
  ));
  const audioStale = Boolean(activeAudio?.path) && (
    String(activeAudio.narrationText || '') !== String(scene.narrationText || '') ||
    (activeAudio.provider !== 'recorded' && String(activeAudio.provider || '') !== String(voiceStore.get().audioProvider || ''))
  );
  const videoManifestStale = videoManifestStaleness(scene, shot, activeImage, activeVideo);
  const selectedStartFrame = shot.startFrame || activeImage?.path || '';
  const videoStale = Boolean(activeVideo?.path) && (videoManifestStale ?? String(activeVideo.sourceImagePath || '') !== String(selectedStartFrame));
  const subtitleStale = Boolean(activeSubtitle?.path) && String(activeSubtitle.sourceAudioPath || '') !== String(activeAudio?.path || '');

  return { promptStale, imageStale, audioStale, videoStale, subtitleStale };
}

// --- Stage status ------------------------------------------------------------

const PLANNING_JOB_TYPES = new Set(['scenes', 'prompts', 'prompt', 'action', 'dialogue']);
const MEDIA_JOB_TYPE = { images: 'image', audio: 'audio', video: 'video', subtitles: 'subtitle' };

function hasText(value) {
  return Boolean(String(value || '').trim());
}

// Newest job per scene for a given job type — the shared lookup behind both the aggregate stage-box
// failed counts (mediaTally below) and the per-scene status-icon failed state (rendering.js), so a
// scene whose last attempt errored (LLM rate limit, provider outage, whatever) is identifiable the
// same way in both places instead of two divergent notions of "failed".
export function buildLatestJobsByScene(recentJobs, jobType) {
  const jobsByScene = new Map();
  for (const job of recentJobs || []) {
    if (job.type !== jobType || !job.sceneId) continue;
    const existing = jobsByScene.get(job.sceneId);
    const active = ['queued', 'running'].includes(job.status);
    const existingActive = ['queued', 'running'].includes(existing?.status);
    // A queued video attempt outlives the short HTTP job that created it. Prefer that durable
    // active state even when a later duplicate HTTP job already appears as "succeeded".
    if (!existing || (active && !existingActive) || (active === existingActive && new Date(job.createdAt) > new Date(existing.createdAt))) jobsByScene.set(job.sceneId, job);
  }
  return jobsByScene;
}

function mediaTally(scenes, { hasVersion, isStale, jobType, recentJobs }) {
  let done = 0, stale = 0, missing = 0, failed = 0, pending = 0;
  const jobsByScene = buildLatestJobsByScene(recentJobs, jobType);
  for (const scene of scenes) {
    if (hasVersion(scene)) {
      if (isStale(scene)) stale += 1; else done += 1;
      continue;
    }
    const lastJob = jobsByScene.get(scene.id);
    if (lastJob?.status === 'failed') failed += 1;
    else if (['queued', 'running'].includes(lastJob?.status)) pending += 1;
    else missing += 1;
  }
  return { total: scenes.length, done, stale, missing, failed, pending };
}

// Shot count is never one of these comparisons -- it isn't a planning input anymore, it's an output
// of planning (see planShots), so there is nothing here for it to drift against.
export function hasPlanningChanges(scenes, record) {
  if (!scenes || scenes.length === 0) return true;
  if (!record) return false;
  const last = record.lastPromptInputs;
  if (!last) return false;

  const norm = (val) => String(val || '').trim();

  const scriptChanged = norm(last.scriptText) !== norm(record.scriptText);
  const commonPromptChanged = norm(last.commonPromptText) !== norm(record.commonPromptText);
  const styleChanged = norm(last.styleId) !== norm(record.styleId);
  const providerChanged = norm(last.textProvider) !== norm(record.textProvider);
  const enrichChanged = Boolean(last.enrich) !== Boolean(record.enrich);
  // maxShots is a real planning input (the ceiling passed to shot-planning), not the output shot
  // count -- comparing it here is unrelated to the old sceneCount-guess comparison this replaced.
  const maxShotsChanged = (last.maxShots || null) !== (record.maxShots || null);

  return scriptChanged || commonPromptChanged || styleChanged || providerChanged || enrichChanged || maxShotsChanged;
}

// `recentJobs` is the project's job list from `GET /api/jobs?projectId=` (already durable and
// tenant-scoped) — `failed` must be derivable after a reload, so it is never read from batchState
// alone. `stageRuns` is the one bit of persisted USER INTENT (`record.stageRuns`, only ever written
// when the user explicitly paused a stage) — needed because in-memory `batchState` resets on reload
// and would otherwise make a paused stage indistinguishable from one that simply hasn't started.
// Everything else here is recomputed from live scene content on every call; nothing else is persisted.
export function computeStageStatus(scenes, batchState, uiOperation, recentJobs = [], stageRuns = {}) {
  const total = scenes.length;
  const record = getCurrentStoryboardRecord();
  const planningChanged = record ? hasPlanningChanges(scenes, record) : false;

  const promptsReady = scenes.filter((scene) => hasText(scene.prompt)).length;
  const dialogueReady = scenes.filter((scene) => hasText(scene.narrationText)).length;
  const promptsStaleCount = scenes.filter((scene) => hasText(scene.prompt) && computeStaleness(scene).promptStale).length;
  const lastPlanningJob = [...(recentJobs || [])]
    .filter((job) => PLANNING_JOB_TYPES.has(job.type) && !job.sceneId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

  const planning = {
    total,
    done: total ? Math.min(promptsReady, dialogueReady) - promptsStaleCount : 0,
    stale: promptsStaleCount,
    missing: total ? total - Math.min(promptsReady, dialogueReady) : 0,
    failed: !total && lastPlanningJob?.status === 'failed' ? 1 : 0,
    running: uiOperation != null && ['planShots', 'prompts', 'dialogueAll', 'prompt', 'dialogue', 'action', 'splitScene'].includes(uiOperation.type),
    paused: false,
    label: total ? `${total} shot${total === 1 ? '' : 's'}` : 'Not started',
    hasChanges: planningChanged,
  };
  planning.done = Math.max(0, planning.done);

  const images = mediaTally(scenes, {
    hasVersion: (scene) => { const shot = imageShot(scene); return Boolean(shot.versions[shot.activeVersionIndex]?.path); },
    isStale: (scene) => computeStaleness(scene).imageStale,
    jobType: MEDIA_JOB_TYPE.images,
    recentJobs,
  });
  const audio = mediaTally(scenes, {
    hasVersion: (scene) => Boolean((scene.audioVersions || [])[scene.activeAudioVersionIndex]?.path),
    isStale: (scene) => computeStaleness(scene).audioStale,
    jobType: MEDIA_JOB_TYPE.audio,
    recentJobs,
  });
  const video = mediaTally(scenes, {
    hasVersion: (scene) => { const shot = imageShot(scene); return Boolean((shot.videoVersions || [])[shot.activeVideoVersionIndex]?.path); },
    isStale: (scene) => computeStaleness(scene).videoStale,
    jobType: MEDIA_JOB_TYPE.video,
    recentJobs,
  });
  const subtitles = mediaTally(scenes, {
    hasVersion: (scene) => Boolean((scene.subtitleVersions || [])[scene.activeSubtitleVersionIndex]?.path),
    isStale: (scene) => computeStaleness(scene).subtitleStale,
    jobType: MEDIA_JOB_TYPE.subtitles,
    recentJobs,
  });

  for (const [key, tally] of [['images', images], ['audio', audio], ['video', video], ['subtitles', subtitles]]) {
    const batch = batchState?.[key === 'video' ? 'videos' : key];
    tally.running = Boolean(batch?.generating);
    // In-memory batch state alone doesn't survive a reload; `stageRuns[key] === 'paused'` is the
    // persisted fallback so a refreshed page still shows "paused" instead of a bare count.
    tally.paused = batch?.state === 'paused' || stageRuns?.[key] === 'paused';
    tally.label = tally.total
      ? `${tally.done}/${tally.total}${tally.stale ? ` (${tally.stale} stale)` : ''}${tally.failed ? ` (${tally.failed} failed)` : ''}`
        + `${tally.pending ? ` (${tally.pending} queued)` : ''}`
      : 'Not started';
  }

  return { planning, images, audio, video, subtitles };
}

// --- Durable job snapshot -----------------------------------------------------

// Small, explicitly-refreshed cache (not re-fetched on every render) — callers refresh it at load
// and after a batch/planning run settles, per the "recompute from scenes/jobs, don't build a second
// status system" requirement.
let cachedJobs = [];

export async function refreshRecentJobs(projectId) {
  if (!projectId) { cachedJobs = []; return cachedJobs; }
  try {
    const data = await api(`/api/jobs?projectId=${encodeURIComponent(projectId)}`);
    cachedJobs = data.jobs || [];
  } catch (_) {
    cachedJobs = [];
  }
  return cachedJobs;
}

export function getCachedJobs() {
  return cachedJobs;
}

const EMPTY_SPEND = Object.freeze({ totalCostUSD: 0, totalTokens: 0, totalCredits: 0, totalCreditMicros: '0', providers: {}, activePrices: [], unpriced: [], videoModels: [] });

export async function refreshSpend(projectId) {
  if (!projectId) {
    spendStore.set(EMPTY_SPEND);
    return spendStore.get();
  }
  try {
    const data = await api(`/api/projects/${encodeURIComponent(projectId)}/tokens`);
    // Do not let a response for a project the user has since navigated away from overwrite the
    // current project's indicator.
    if (projectStore.get().currentId === projectId) spendStore.set(data || EMPTY_SPEND);
  } catch (_) {
    if (projectStore.get().currentId === projectId) spendStore.set(EMPTY_SPEND);
  }
  refreshCreditBalance().catch(() => {});
  return spendStore.get();
}

export function getCachedSpend() {
  return spendStore.get();
}

// --- Planning ------------------------------------------------------------
//
// Narration is generated and locked first, then shots are planned from that immutable narration in
// the same server request (see workflows.js: planShots, and shot-planning.service.js) — the
// returned scene list IS the final structure. There is no separate scene-count guess beforehand, no
// recount-and-reconcile decision afterward, and no auto-add-to-target behavior: shot count is
// simply how many shots the planning call returned. Manual restructuring (splitting one scene,
// replanning the whole project from source) remains separate and user-triggered — see
// splitSceneInPlace (workflows.js) and replanStory below.
export async function runPlanning(els, setStatus) {
  try {
    const count = await planShots(els, setStatus);
    return { stoppedAt: null, finalCount: count };
  } catch (_error) {
    // planShots already reported the error via setStatus; report it as a normal stage stop here
    // too, same as an images/audio/video batch failure, rather than an uncaught rejection.
    return { stoppedAt: 'failed' };
  }
}

// "Update stale only": regenerates prompts for scenes whose prompt provenance is stale, and NEVER
// touches narration — narration and prompts are separate upstream/downstream artifacts, and a stale
// prompt does not imply the narration itself is wrong.
export async function updateStalePlanning(els, setStatus, range) {
  if (uiStore.get().operation) return;
  const scenes = sceneStore.get().scenes;
  let staleIndexes = scenes
    .map((scene, index) => (computeStaleness(scene).promptStale ? index : -1))
    .filter((index) => index !== -1);
  if (range) staleIndexes = staleIndexes.filter((index) => index >= range.startIndex && index < range.endIndex);

  if (!staleIndexes.length) {
    if (setStatus) setStatus('Nothing to update — no stale prompts.');
    return;
  }

  uiStore.set({ operation: { type: 'planningStaleUpdate' } });
  try {
    for (const index of staleIndexes) {
      await regeneratePrompt(index, els, setStatus, true); // withinSerial=true: never regenerateDialogue
    }
    if (setStatus) setStatus(`Updated ${staleIndexes.length} stale prompt${staleIndexes.length === 1 ? '' : 's'}.`);
  } finally {
    uiStore.set({ operation: null });
  }
}

// Explicit, destructive structural rebuild — re-plans from source (narrate -> plan shots, same as
// planShots/runPlanning), discarding the old scene structure. Only ever reachable after a confirm
// that names the actual consequence. No target count goes in and none is expected back: replanning
// follows the same invariant as initial planning — shot count is whatever the fresh plan produces,
// never a requested/reconciled number. Cleanup is called ONLY after the rebuilt document write has
// succeeded (planShots's own project write already fails closed on REVISION_CONFLICT) — never
// speculatively/in parallel with that write — so a still-current document is never swept.
export async function replanStory(els, setStatus) {
  await planShots(els, setStatus);
  const projectId = projectStore.get().currentId;
  if (!projectId) return;
  try {
    await api(`/api/projects/${encodeURIComponent(projectId)}/cleanup`, { method: 'POST' });
  } catch (_) {
    // Best-effort: a failed cleanup call leaves orphaned assets on disk but does not affect the
    // correctness of the rebuild that already committed successfully; it can be retried later.
  }
}

// --- Images/Audio/Video batch orchestration ---------------------------------

const MEDIA_STAGE_CONFIG = {
  images: {
    regenerate: regenerateImage,
    hasVersion: (scene) => { const shot = imageShot(scene); return Boolean(shot.versions[shot.activeVersionIndex]?.path); },
    isStale: (scene) => computeStaleness(scene).imageStale,
  },
  audio: {
    regenerate: regenerateAudio,
    hasVersion: (scene) => Boolean((scene.audioVersions || [])[scene.activeAudioVersionIndex]?.path),
    isStale: (scene) => computeStaleness(scene).audioStale,
  },
  video: {
    regenerate: regenerateVideo,
    hasVersion: (scene) => { const shot = imageShot(scene); return Boolean((shot.videoVersions || [])[shot.activeVideoVersionIndex]?.path); },
    isStale: (scene) => computeStaleness(scene).videoStale,
  },
  subtitles: {
    regenerate: regenerateSubtitles,
    hasVersion: (scene) => Boolean((scene.subtitleVersions || [])[scene.activeSubtitleVersionIndex]?.path),
    isStale: (scene) => computeStaleness(scene).subtitleStale,
  },
};

// batchStore/batchController key videos by the plural 'videos'; every other stage-facing API in
// this module uses the singular 'video' to match computeStageStatus's shape. This is the one place
// that needs to know about the mismatch. Subtitles has no such split -- the stage key is already
// plural ('subtitles') everywhere.
const BATCH_STORE_KEY = { images: 'images', audio: 'audio', video: 'videos', subtitles: 'subtitles' };

function resolveLiveScene(id) {
  return sceneStore.get().scenes.find((scene) => scene.id === id) || null;
}

function buildBatchFns(stage, els, setStatus, onlyMissingOrStale, range) {
  const config = MEDIA_STAGE_CONFIG[stage];
  const allScenes = sceneStore.get().scenes;
  const { startIndex = 0, endIndex = allScenes.length } = range || {};
  // `{ id }` objects, not raw id strings — batch.js's own loop reads `scene.id` directly (to stamp
  // `uiStore.operation.sceneId`, which drives the per-scene-card loading spinner), so the frozen
  // snapshot must expose `.id`, not just be indexable by position. Slicing to the requested range
  // (default: the whole project) is the entire mechanism for scoping a run to a scene range —
  // batchController itself is plain index-based and needs no knowledge of ranges at all.
  const frozenScenes = allScenes.slice(startIndex, endIndex).map((scene) => ({ id: scene.id }));
  const activeJobsByScene = buildLatestJobsByScene(cachedJobs, MEDIA_JOB_TYPE[stage]);
  const generateFn = async (index) => {
    const scene = resolveLiveScene(frozenScenes[index]?.id);
    if (!scene) return true; // removed mid-batch: skip, don't fail the whole batch
    if (['queued', 'running'].includes(activeJobsByScene.get(scene.id)?.status)) return true;
    if (onlyMissingOrStale && config.hasVersion(scene) && !config.isStale(scene)) return true; // already fresh: skip
    // `index` here is relative to the frozen/sliced range (0 at the range's start), not the scene's
    // real position in the storyboard — regenerate* uses this index for user-facing scene numbers
    // (status text, "scene N" labels, the generated file's numeric prefix), and every other caller
    // of regenerate* passes the real storyboard index, never a range-relative one. Passing the raw
    // frozen index here made a range-scoped restart (e.g. "start from scene 7") correctly touch the
    // right scene's data (attachment is keyed by sceneId, not this index) but incorrectly label it
    // "scene 1" everywhere the label is shown — looking exactly like the run had restarted from the
    // beginning even though it hadn't. `startIndex + index` restores the real position.
    try {
      return await config.regenerate(startIndex + index, scene, els, setStatus, true);
    } finally {
      // Failed provider calls can still have measured/reserved usage, so refresh on every settled
      // attempt, not only successful media creation.
      await refreshSpend(projectStore.get().currentId);
    }
  };
  // batch.js reads `.length`, `scenes[i].id` (for the operation/spinner), and passes `scenes[i]`
  // positionally into generateFn — which ignores that value and re-resolves the live scene by id
  // instead, so a scene-count change mid-batch can't make it operate on the wrong scene.
  const getScenes = () => frozenScenes;
  return { generateFn, getScenes };
}

// Clears the persisted "stopped" flag once a stage's run reaches a non-stopped terminal state, so a
// completed/failed run doesn't keep reading as stopped after the fact. Only ever writes
// `record.stageRuns` — actual done/stale/missing/failed counts are never persisted (phase 1/5).
// The persisted value stays the internal string 'paused' (not user-facing copy — the Start/Stop UI
// never says "paused") so existing persisted `record.stageRuns` data needs no migration.
function syncPauseIntent(stage, finalState, setStatus) {
  // `finalState` is `undefined` when batchController.start declined to run at all — that's a
  // no-op, not a status change, so leave whatever was already persisted alone.
  if (finalState === undefined) return;
  const record = getCurrentStoryboardRecord();
  if (!record) return;
  record.stageRuns = record.stageRuns || {};
  const next = finalState === 'paused' ? 'paused' : null;
  if (record.stageRuns[stage] === next) return;
  record.stageRuns[stage] = next;
  queueSync(record, setStatus);
}

// Runs a batch over a scene snapshot taken ONCE at batch start (`frozenScenes`), not the live
// `sceneStore` array — batch.js's own loop is positional and long-running, so a scene-count change
// mid-batch (a Planning scene-count acceptance, an explicit expansion) must not let it silently
// pick up or misattribute scenes. Every step re-resolves the CURRENT live scene by id; if that id no
// longer exists (removed by a Replan/expansion mid-batch), the step is skipped, not fatal — same
// "skip this one, keep going" shape regenerateAudio/regenerateVideo already use for missing
// prerequisites (workflows.js).
async function runStageBatch(stage, els, setStatus, { onlyMissingOrStale, range }) {
  // Persist local edits once before the run. Every media endpoint commits its own scene update, so
  // PUTting the whole project again before every scene only creates revision conflicts with those
  // successful commits (and with asynchronous video completion).
  await ensureProjectSynced();
  await refreshRecentJobs(projectStore.get().currentId);
  const { generateFn, getScenes } = buildBatchFns(stage, els, setStatus, onlyMissingOrStale, range);
  if (!getScenes().length) return;
  const finalState = await batchController.start(BATCH_STORE_KEY[stage], generateFn, getScenes);
  syncPauseIntent(stage, finalState, setStatus);
  // Land the selected-scene anchor on wherever this run actually stopped, so the next Start
  // continues from there. `currentIndex` is only advanced past a scene once its generateFn call
  // resolves without throwing (batch.js), so this single read already distinguishes "stopped after
  // the in-flight scene committed" (currentIndex points at the NEXT scene) from "stopped before it
  // committed" (currentIndex still points at that same scene) from "ran to completion" (clamped to
  // the last scene) — no separate stop/complete branching needed here.
  if (finalState) {
    const frozen = getScenes();
    const cursor = batchStore.get()[BATCH_STORE_KEY[stage]].currentIndex;
    const landingScene = frozen[Math.min(cursor, frozen.length - 1)];
    if (landingScene) uiStore.set({ selectedSceneId: landingScene.id });
  }
  return finalState;
}

// Default action: generate whatever is missing or stale, skipping scenes that are already present
// and fresh. This is what a checked stage box runs when Start is clicked — resuming a paused stage
// is the same call: already-fresh scenes are skipped cheaply, so re-running never wastes a provider
// call on completed work.
export async function generateMissingOrStale(stage, els, setStatus, range) {
  return runStageBatch(stage, els, setStatus, { onlyMissingOrStale: true, range });
}

// Explicit, unconditional regenerate-everything (Settings > Danger zone only). Callers must route
// this through the existing confirm-modal/preflight flow before invoking it — this function itself
// has no confirmation gate, by design, so there is exactly one place spend-relevant confirmation can
// be forgotten to check, not two.
export async function regenerateAllStage(stage, els, setStatus) {
  return runStageBatch(stage, els, setStatus, { onlyMissingOrStale: false });
}

// --- Stop ---------------------------------------------------------------------
//
// Single Start/Stop model — no separate Pause vs Cancel. Stop is always resumable: the next Start
// continues from wherever it left off (see the landing-scene logic in runStageBatch above), so
// there's no second "harder stop that discards progress" concept left to distinguish.
//
// Images/Audio/Video have a genuine client-side per-scene loop, so stopping them and continuing
// from progress both really work. Planning does not: `plan-shots` is a single batched server
// request with no per-scene client loop to stop mid-flight. Stopping Planning therefore cancels the
// in-flight request (existing job/lease-abort path) — callers should expect `kind === 'cancelled'`
// there, not restart-from-progress behavior, since none exists for this stage.
export function stopActiveWork(projectId) {
  const activeMediaStage = ['images', 'audio', 'video', 'subtitles'].find((stage) => batchStore.get()[BATCH_STORE_KEY[stage]]?.generating);
  if (activeMediaStage) {
    batchController.stop(BATCH_STORE_KEY[activeMediaStage], projectId);
    return { kind: 'paused', stage: activeMediaStage };
  }
  if (uiStore.get().operation) {
    void cancelActiveProjectJobs(projectId);
    return { kind: 'cancelled', stage: 'planning' };
  }
  return { kind: 'idle', stage: null };
}

// --- One-shot presets --------------------------------------------------------

const PRESET_STAGES = {
  storyboard: ['planning', 'images'],
  'full-story': ['planning', 'images', 'audio', 'subtitles'],
  'full-production': ['planning', 'images', 'audio', 'video', 'subtitles'],
};

let flowStopRequested = false;

// Shares the same Pause/Cancel control as a single stage — calling this just requests that the
// *next* stage boundary (or the scene-count decision) not be crossed; it does not itself stop
// whatever is currently running (call `pauseActiveWork` for that, same as a standalone stage run).
export function stopCreateStoryFlow() {
  flowStopRequested = true;
}

// Sequences Planning -> Images -> Audio -> Video per preset. Pure orchestration over the functions
// built in the earlier phases — no new execution engine, no parallel state machine.
//
// Planning no longer has a structural decision point to stop at: `runPlanning` always runs straight
// through (narrate -> plan shots) and returns the final structure, so image/audio/video work can
// proceed as soon as it resolves.
// `range` scopes Images/Audio/Video to a slice of the project (default: everything — see
// buildBatchFns) and scopes Planning's stale-only path the same way; Planning's full-sequence path
// never accepts a range (see updateStalePlanning above). `forceStages` names stages that must
// process their whole range unconditionally rather than skipping already-fresh scenes — this is
// set when the Start modal's "Regenerate if exists" is checked, or when a stage box is checked
// despite having nothing missing/stale (see buildRunRowStatus / computeForceStages).
export async function runCreateStoryFlow(preset, els, setStatus, { stages: customStages, range, forceStages = [] } = {}) {
  flowStopRequested = false;
  const stages = preset === 'custom' ? (customStages || []) : PRESET_STAGES[preset];
  if (!stages || !stages.length) return { stoppedAt: 'noStages' };

  if (stages.includes('planning')) {
    const planningStatus = computeStageStatus(sceneStore.get().scenes, batchStore.get(), uiStore.get().operation, getCachedJobs()).planning;
    const planningAction = classifyPlanningRun(planningStatus, { force: forceStages.includes('planning') });
    // A brand-new project (no scenes at all yet) always needs the full sequence — computeStageStatus
    // reports `missing: 0` for an empty scene list (there's nothing to divide a ratio by), which is
    // NOT the same as "already planned."
    if (planningAction === 'full') {
      // No plan yet, or an incomplete one, or script/settings changed: run the full sequence
      // (narrate -> plan shots), same as a standalone Planning run. Never scoped by range —
      // planning has no safe partial-segmentation mode.
      const planningResult = await runPlanning(els, setStatus);
      if (planningResult.stoppedAt) return planningResult;
    } else if (planningAction === 'stale') {
      // A complete plan already exists — only its stale prompts need fixing, optionally scoped to
      // range. Never regenerate narration or re-run the whole sequence just because a downstream
      // box was checked.
      await updateStalePlanning(els, setStatus, range);
    }
    // Both missing and stale are 0: planning is already up to date, nothing to do.
  }
  if (flowStopRequested) return { stoppedAt: 'paused' };

  for (const stage of ['images', 'audio', 'video', 'subtitles']) {
    if (!stages.includes(stage)) continue;
    if (flowStopRequested) return { stoppedAt: 'paused', atStage: stage };
    const finalState = await runStageBatch(stage, els, setStatus, { onlyMissingOrStale: !forceStages.includes(stage), range });
    if (finalState === 'paused' || finalState === 'failed') return { stoppedAt: finalState, atStage: stage };
  }
  return { stoppedAt: null };
}

// --- Stage-box selection (what Start will act on) ---------------------------
//
// The 4 stage boxes double as the run's target list: a box defaults to selected only when it has
// detected actionable work, but the user can always toggle any box either way — our staleness
// tracking is a heuristic (per-scene field drift), not a complete picture. It can't see, for
// example, that the underlying prompt-generation logic changed server-side, or that the user just
// wants to force a re-run — permanently disabling a box for those cases is confusing, so a box is
// never unclickable. Instead, a run that includes a stage with no detected work gets a strong
// warning in the confirmation screen (see getGenerationPreflight('startRun', ...) in app.js) rather
// than being silently blocked. This is in-memory only (resets on reload, same as any other
// transient UI state) and always re-derives its default from live status, not a stored preference.
const ALL_STAGES = ['planning', 'images', 'audio', 'video', 'subtitles'];
const manualSelectionOverride = {};

// --- Selected scene (run anchor) ---------------------------------------------
//
// `selectedSceneId` (uiStore) is the scene the user last interacted with — clicked, previewed, or
// used an inline entity-modal control on — and is where a Start run begins. It's resolved
// defensively everywhere it's read (never-selected-yet and selected-scene-was-removed both fall
// back to index 0) so callers never need their own null-checking.
export function resolveSelectedSceneIndex(scenes, selectedSceneId) {
  if (!scenes.length) return 0;
  const index = scenes.findIndex((scene) => scene.id === selectedSceneId);
  return index === -1 ? 0 : index;
}

// rangeMode: 'all' | 'next'. 'all' always means selected scene -> end of project, enforced
// uniformly for every stage a run touches — there is no per-stage deviation from this.
export function computeRunRange(scenes, selectedSceneId, rangeMode, count) {
  const startIndex = resolveSelectedSceneIndex(scenes, selectedSceneId);
  const endIndex = rangeMode === 'next'
    ? Math.min(scenes.length, startIndex + Math.max(1, Number(count) || 1))
    : scenes.length;
  return { startIndex, endIndex };
}

export function stageHasActionableWork(stage, stageStatus) {
  // A brand-new project has no scenes yet, so every stage's tally reads 0/0/0 — but Planning is
  // still the one stage that always has something to do in that state (it's what creates the
  // scenes). Images/Audio/Video genuinely have nothing to do until scenes exist.
  if (stage === 'planning') {
    if (stageStatus.total === 0 || stageStatus.hasChanges) return true;
  }
  return stageStatus.missing > 0 || stageStatus.stale > 0 || stageStatus.failed > 0;
}

// Shared with the run UI so its description and runCreateStoryFlow use the
// same decision tree when classifying Planning work.
export function classifyPlanningRun(planningStatus, { force = false } = {}) {
  if (planningStatus.missing > 0 || planningStatus.total === 0 || planningStatus.hasChanges || force) return 'full';
  if (planningStatus.stale > 0) return 'stale';
  return 'current';
}

// Returns { planning, images, audio, video } booleans: whether each box is currently selected to
// be included the next time Start runs.
export function getStageSelection(status) {
  return ALL_STAGES.reduce((acc, stage) => {
    const hasWork = stageHasActionableWork(stage, status[stage]);
    const override = manualSelectionOverride[stage];
    acc[stage] = override === undefined ? hasWork : override;
    return acc;
  }, {});
}

// Always toggles — a box with no detected work can still be selected; Start's confirmation screen
// is where that gets flagged, not here.
export function toggleStageSelection(stage, status) {
  const current = getStageSelection(status)[stage];
  manualSelectionOverride[stage] = !current;
}

// Drives both the Start modal's row text and its checkbox defaults from one source, so they can
// never disagree. Each stage gets `{ full, ranged }`: `full` is the whole-project tally (what the
// read-only outer strip already shows, e.g. "48/48 complete"), `ranged` is the same tally computed
// over just the selected range (what decides whether the box defaults to checked). Planning has no
// range-scoped mode (see runCreateStoryFlow), so its `ranged` is just its `full` again.
export function buildRunRowStatus(scenes, range, batchState, uiOperation, recentJobs, stageRuns) {
  const full = computeStageStatus(scenes, batchState, uiOperation, recentJobs, stageRuns);
  const rangeScenes = scenes.slice(range.startIndex, range.endIndex);
  const ranged = computeStageStatus(rangeScenes, batchState, uiOperation, recentJobs, stageRuns);
  return ALL_STAGES.reduce((acc, stage) => {
    acc[stage] = { full: full[stage], ranged: stage === 'planning' ? full[stage] : ranged[stage] };
    return acc;
  }, {});
}

// Stages whose box is checked despite having no actionable work in the selected range — i.e. the
// user explicitly overrode a default of "nothing to do here". There's nothing for the normal
// skip-fresh run to skip *to* in that case, so these stages must process their entire range
// unconditionally instead (see runCreateStoryFlow's `forceStages`). For Planning, explicitly
// checking an otherwise-up-to-date row requests a complete replan.
export function computeForceStages(rowStatus, selection) {
  return ALL_STAGES.filter((stage) => (
    selection[stage] && !stageHasActionableWork(stage, rowStatus[stage].ranged)
  ));
}
