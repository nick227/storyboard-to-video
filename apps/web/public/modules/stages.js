import { api, cancelActiveProjectJobs } from './api.js';
import { sceneStore, uiStore, projectStore, batchStore, voiceStore } from './store.js';
import { generateDialogue, generatePrompts, regeneratePrompt, addRecommendedScenes, regenerateImage, regenerateAudio, regenerateVideo } from './workflows.js';
import { suggestSceneCount, suggestSceneCountFromNarration } from './scene-count.js';
import { batchController } from './batch.js';
import { getCurrentStoryboardRecord, queueSync } from './persistence.js';

// --- Staleness -------------------------------------------------------------

// Provenance fields (promptGeneratedFromBeat / promptGeneratedFromNarration / audio version
// narrationText) are server-authored (see prompt-generation.service.js / audio-generation.service.js)
// so staleness survives reloads and concurrent tabs instead of depending on client-held state. The
// audio provider check is the one exception: it compares against the currently selected
// voiceStore.audioProvider so switching providers immediately marks existing audio stale, even
// though that selection isn't itself part of the persisted version's provenance snapshot.
export function computeStaleness(scene) {
  const activeImage = (scene.versions || [])[scene.activeVersionIndex] || null;
  const activeAudio = (scene.audioVersions || [])[scene.activeAudioVersionIndex] || null;
  const activeVideo = (scene.videoVersions || [])[scene.activeVideoVersionIndex] || null;

  const hasPrompt = Boolean(String(scene.prompt || '').trim());
  const promptStale = hasPrompt && (
    String(scene.beat || '') !== String(scene.promptGeneratedFromBeat || '') ||
    (scene.promptGeneratedFromNarration != null && String(scene.narrationText || '') !== String(scene.promptGeneratedFromNarration))
  );

  // Compare against `scenePrompt` (the raw scene-level prompt), not `prompt` — the version's
  // `prompt` field is the full composed provider prompt (style + common + scene + extra) and can
  // never equal `scene.prompt` alone, which would make every image read as permanently stale.
  const imageStale = Boolean(activeImage?.path) && String(activeImage.scenePrompt || '') !== String(scene.prompt || '');
  const audioStale = Boolean(activeAudio?.path) && (
    String(activeAudio.narrationText || '') !== String(scene.narrationText || '') ||
    String(activeAudio.provider || '') !== String(voiceStore.get().audioProvider || '')
  );
  const videoStale = Boolean(activeVideo?.path) && String(activeVideo.sourceImagePath || '') !== String(activeImage?.path || '');

  return { promptStale, imageStale, audioStale, videoStale };
}

// --- Stage status ------------------------------------------------------------

const PLANNING_JOB_TYPES = new Set(['scenes', 'prompts', 'prompt', 'action', 'dialogue']);
const MEDIA_JOB_TYPE = { images: 'image', audio: 'audio', video: 'video' };

function hasText(value) {
  return Boolean(String(value || '').trim());
}

function mediaTally(scenes, { hasVersion, isStale, jobType, recentJobs }) {
  let done = 0, stale = 0, missing = 0, failed = 0;
  const jobsByScene = new Map();
  for (const job of recentJobs || []) {
    if (job.type !== jobType || !job.sceneId) continue;
    const existing = jobsByScene.get(job.sceneId);
    if (!existing || new Date(job.createdAt) > new Date(existing.createdAt)) jobsByScene.set(job.sceneId, job);
  }
  for (const scene of scenes) {
    if (hasVersion(scene)) {
      if (isStale(scene)) stale += 1; else done += 1;
      continue;
    }
    const lastJob = jobsByScene.get(scene.id);
    if (lastJob?.status === 'failed') failed += 1; else missing += 1;
  }
  return { total: scenes.length, done, stale, missing, failed };
}

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

  // Compare sceneCount
  const lastCount = Number(last.sceneCount) || 8;
  const isAuto = record.sceneCountMode === 'auto';
  const customVal = record.sceneCount ? Number(record.sceneCount) : null;
  let currentCount = 8;
  if (isAuto) {
    if (scenes && scenes.length > 0) {
      currentCount = suggestSceneCountFromNarration(scenes) || scenes.length;
    } else {
      currentCount = suggestSceneCount(record.scriptText) || 8;
    }
  } else {
    currentCount = customVal || 8;
  }

  const countChanged = lastCount !== currentCount;

  return scriptChanged || commonPromptChanged || styleChanged || providerChanged || enrichChanged || countChanged;
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
    running: uiOperation != null && ['prompts', 'dialogueAll', 'prompt', 'dialogue', 'action', 'splitScene'].includes(uiOperation.type),
    paused: false,
    label: total ? `${total} scenes` : 'Not started',
    hasChanges: planningChanged,
  };
  planning.done = Math.max(0, planning.done);

  const images = mediaTally(scenes, {
    hasVersion: (scene) => Boolean((scene.versions || [])[scene.activeVersionIndex]?.path),
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
    hasVersion: (scene) => Boolean((scene.videoVersions || [])[scene.activeVideoVersionIndex]?.path),
    isStale: (scene) => computeStaleness(scene).videoStale,
    jobType: MEDIA_JOB_TYPE.video,
    recentJobs,
  });

  for (const [key, tally] of [['images', images], ['audio', audio], ['video', video]]) {
    const batch = batchState?.[key === 'video' ? 'videos' : key];
    tally.running = Boolean(batch?.generating);
    // In-memory batch state alone doesn't survive a reload; `stageRuns[key] === 'paused'` is the
    // persisted fallback so a refreshed page still shows "paused" instead of a bare count.
    tally.paused = batch?.state === 'paused' || stageRuns?.[key] === 'paused';
    tally.label = tally.total
      ? `${tally.done}/${tally.total}${tally.stale ? ` (${tally.stale} stale)` : ''}${tally.failed ? ` (${tally.failed} failed)` : ''}`
      : 'Not started';
  }

  return { planning, images, audio, video };
}

// --- Primary action ----------------------------------------------------------

// Always the next useful step: Plan Story -> Generate Images -> Generate Audio -> Generate Video
// -> Resume (if anything is paused/failed) -> idle. Pure function so it's trivially testable.
export function getPrimaryAction(stageStatus) {
  const { planning, images, audio, video } = stageStatus;

  const paused = ['images', 'audio', 'video'].find((key) => stageStatus[key].paused);
  if (paused) return { stage: paused, label: 'Resume', kind: 'resume' };

  if (!planning.total || planning.missing > 0) {
    return { stage: 'planning', label: planning.total ? 'Continue Planning' : 'Plan Story', kind: 'plan' };
  }
  if (images.missing > 0 || images.stale > 0) return { stage: 'images', label: 'Generate Images', kind: 'generateMissingOrStale' };
  if (audio.missing > 0 || audio.stale > 0) return { stage: 'audio', label: 'Generate Audio', kind: 'generateMissingOrStale' };
  if (video.missing > 0 || video.stale > 0) return { stage: 'video', label: 'Generate Video', kind: 'generateMissingOrStale' };

  return { stage: null, label: 'All stages complete', kind: 'idle' };
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

// --- Planning ------------------------------------------------------------
//
// Ordering is deliberate and matches the approved plan exactly: visual prompts must never be
// generated until the final scene count is locked in, otherwise prompt work is wasted on a
// structure about to be replaced. The granular steps below are exposed separately (rather than one
// monolithic function) so the interactive Planning modal can drive them one at a time with a real
// blocking UI prompt in between, while the one-shot Create Story flow (phase 6) can drive the exact
// same steps with a supplied decision callback instead of a modal.

// Steps 1-2: initial source segmentation (create-scenes, no LLM) + narration. Reuses
// `generateDialogue`, which already creates the skeleton first if scenes don't exist yet.
export async function startPlanning(els, setStatus) {
  await generateDialogue(els, setStatus);
  const scenes = sceneStore.get().scenes;
  return { currentCount: scenes.length, recommended: suggestSceneCountFromNarration(scenes) };
}

// Step 5: reconcile scene count to `finalCount` — BEFORE any prompts exist. Only ever grows
// in-place (via the existing non-destructive split primitives); a `finalCount` below the current
// scene count has no safe merge primitive in this codebase and must go through `replanStory`
// instead, so this returns `needsReplan: true` rather than attempting a silent shrink.
export async function allocateFinalSceneCount(finalCount, els, setStatus) {
  const current = sceneStore.get().scenes.length;
  if (finalCount > current) {
    await addRecommendedScenes(finalCount, els, setStatus);
    return { needsReplan: false };
  }
  if (finalCount < current) return { needsReplan: true };
  return { needsReplan: false };
}

// Step 6: only ever called once the scene count is final — generates physical actions/visual
// prompts against the now-fixed scene structure, reusing existing scene boundaries.
export async function finishPlanning(els, setStatus) {
  await generatePrompts(els, setStatus, { rebuildFromSource: false });
}

// Convenience wrapper for callers that want the whole sequence driven programmatically (the
// one-shot flow). `onSceneCountDecision({ recommended, currentCount })` must return the user's
// chosen final count, or `null`/`undefined` to stop here without deciding (e.g. a modal was
// dismissed). Interactive UI should prefer calling the granular steps above directly instead of this
// wrapper, so the blocking scene-count prompt is real UI, not a callback contract.
export async function runPlanning(els, setStatus, { onSceneCountDecision } = {}) {
  const { currentCount, recommended } = await startPlanning(els, setStatus);
  let finalCount = currentCount;
  if (recommended !== currentCount) {
    if (!onSceneCountDecision) return { stoppedAt: 'sceneCountDecision', recommended, currentCount };
    finalCount = await onSceneCountDecision({ recommended, currentCount });
    if (finalCount == null) return { stoppedAt: 'sceneCountDecision', recommended, currentCount };
  }
  const { needsReplan } = await allocateFinalSceneCount(finalCount, els, setStatus);
  if (needsReplan) return { stoppedAt: 'needsReplanForShrink', recommended, currentCount, finalCount };
  await finishPlanning(els, setStatus);
  return { stoppedAt: null, finalCount };
}

// "Update stale only": regenerates prompts for scenes whose prompt provenance is stale, and NEVER
// touches narration — narration and prompts are separate upstream/downstream artifacts, and a stale
// prompt does not imply the narration itself is wrong.
export async function updateStalePlanning(els, setStatus) {
  if (uiStore.get().operation) return;
  const scenes = sceneStore.get().scenes;
  const staleIndexes = scenes
    .map((scene, index) => (computeStaleness(scene).promptStale ? index : -1))
    .filter((index) => index !== -1);

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

// Explicit, destructive structural rebuild — re-segments from source at the current sceneCount
// input, discarding the old scene structure. Only ever reachable after a confirm that names the
// actual consequence (see planning modal copy), including when it's really "reduce scene count"
// rather than a generic replan. Cleanup is called ONLY after the rebuilt document write has
// succeeded (generatePrompts's own project write already fails closed on REVISION_CONFLICT) — never
// speculatively/in parallel with that write — so a still-current document is never swept.
export async function replanStory(els, setStatus) {
  await generatePrompts(els, setStatus, { rebuildFromSource: true });
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
    hasVersion: (scene) => Boolean((scene.versions || [])[scene.activeVersionIndex]?.path),
    isStale: (scene) => computeStaleness(scene).imageStale,
  },
  audio: {
    regenerate: regenerateAudio,
    hasVersion: (scene) => Boolean((scene.audioVersions || [])[scene.activeAudioVersionIndex]?.path),
    isStale: (scene) => computeStaleness(scene).audioStale,
  },
  video: {
    regenerate: regenerateVideo,
    hasVersion: (scene) => Boolean((scene.videoVersions || [])[scene.activeVideoVersionIndex]?.path),
    isStale: (scene) => computeStaleness(scene).videoStale,
  },
};

// batchStore/batchController key videos by the plural 'videos'; every other stage-facing API in
// this module uses the singular 'video' to match computeStageStatus's shape. This is the one place
// that needs to know about the mismatch.
const BATCH_STORE_KEY = { images: 'images', audio: 'audio', video: 'videos' };

function resolveLiveScene(id) {
  return sceneStore.get().scenes.find((scene) => scene.id === id) || null;
}

function buildBatchFns(stage, els, setStatus, onlyMissingOrStale) {
  const config = MEDIA_STAGE_CONFIG[stage];
  // `{ id }` objects, not raw id strings — batch.js's own loop reads `scene.id` directly (to stamp
  // `uiStore.operation.sceneId`, which drives the per-scene-card loading spinner), so the frozen
  // snapshot must expose `.id`, not just be indexable by position.
  const frozenScenes = sceneStore.get().scenes.map((scene) => ({ id: scene.id }));
  const generateFn = async (index) => {
    const scene = resolveLiveScene(frozenScenes[index]?.id);
    if (!scene) return true; // removed mid-batch: skip, don't fail the whole batch
    if (onlyMissingOrStale && config.hasVersion(scene) && !config.isStale(scene)) return true; // already fresh: skip
    return config.regenerate(index, scene, els, setStatus, true);
  };
  // batch.js reads `.length`, `scenes[i].id` (for the operation/spinner), and passes `scenes[i]`
  // positionally into generateFn — which ignores that value and re-resolves the live scene by id
  // instead, so a scene-count change mid-batch can't make it operate on the wrong scene.
  const getScenes = () => frozenScenes;
  return { generateFn, getScenes };
}

// Clears the persisted pause flag once a stage's run reaches a non-paused terminal state, so a
// completed/failed run doesn't keep reading as "paused" after the fact. Only ever writes
// `record.stageRuns` — actual done/stale/missing/failed counts are never persisted (phase 1/5).
// Set synchronously by cancelActiveWork BEFORE the batch's stop() call returns, so by the time the
// batch's own start()/resume() promise resolves (asynchronously, later) and syncPauseIntent runs,
// this flag already reflects whether the stop was a Pause (resumable) or a Cancel (not) — resolving
// what would otherwise be a race between "batch resolves as paused" and "user asked to cancel."
const cancelRequestedForStage = {};

function syncPauseIntent(stage, finalState, setStatus) {
  // `finalState` is `undefined` when batchController.start/resume declined to run at all (e.g.
  // `resume` called on a stage that wasn't actually paused/failed) — that's a no-op, not a status
  // change, so leave whatever pause intent was already persisted alone.
  if (finalState === undefined) return;
  const record = getCurrentStoryboardRecord();
  if (!record) return;
  record.stageRuns = record.stageRuns || {};
  const cancelled = cancelRequestedForStage[stage];
  cancelRequestedForStage[stage] = false;
  const next = finalState === 'paused' && !cancelled ? 'paused' : null;
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
async function runStageBatch(stage, els, setStatus, { onlyMissingOrStale }) {
  const { generateFn, getScenes } = buildBatchFns(stage, els, setStatus, onlyMissingOrStale);
  if (!getScenes().length) return;
  const finalState = await batchController.start(BATCH_STORE_KEY[stage], generateFn, getScenes);
  syncPauseIntent(stage, finalState, setStatus);
  return finalState;
}

// Default action: generate whatever is missing or stale, skipping scenes that are already present
// and fresh. This is what a checked stage box runs when Start is clicked — resuming a paused stage
// is the same call: already-fresh scenes are skipped cheaply, so re-running never wastes a provider
// call on completed work.
export async function generateMissingOrStale(stage, els, setStatus) {
  return runStageBatch(stage, els, setStatus, { onlyMissingOrStale: true });
}

// Explicit, unconditional regenerate-everything (Settings > Danger zone only). Callers must route
// this through the existing confirm-modal/preflight flow before invoking it — this function itself
// has no confirmation gate, by design, so there is exactly one place spend-relevant confirmation can
// be forgotten to check, not two.
export async function regenerateAllStage(stage, els, setStatus) {
  return runStageBatch(stage, els, setStatus, { onlyMissingOrStale: false });
}

// --- Pause / Cancel ----------------------------------------------------------
//
// Images/Audio/Video have a genuine client-side per-scene loop, so pausing them and resuming from
// progress both really work. Planning does not: `generate-dialogue`/`generate-prompts` are each a
// single batched server request with no per-scene client loop to pause mid-flight. Stopping Planning
// therefore CANCELS the in-flight request (existing job/lease-abort path) rather than pausing it —
// callers must label the control "Cancel Planning" (not "Pause") while `kind === 'cancelled'`, so
// users don't expect restart-from-progress behavior that doesn't exist for this stage.
export function pauseActiveWork(projectId) {
  const activeMediaStage = ['images', 'audio', 'video'].find((stage) => batchStore.get()[BATCH_STORE_KEY[stage]]?.generating);
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

// Harder stop than Pause: same underlying stop mechanism, but the stage is left in a plain
// not-running state rather than a resumable "paused" one — for a user who wants to abandon the
// current run rather than continue it later. Marking the cancel intent before calling the same
// stop() the Pause path uses avoids a race with the batch's own async resolution (see
// cancelRequestedForStage above).
export function cancelActiveWork(projectId) {
  const activeMediaStage = ['images', 'audio', 'video'].find((stage) => batchStore.get()[BATCH_STORE_KEY[stage]]?.generating);
  if (activeMediaStage) cancelRequestedForStage[activeMediaStage] = true;
  return pauseActiveWork(projectId);
}

// --- One-shot presets --------------------------------------------------------

const PRESET_STAGES = {
  storyboard: ['planning', 'images'],
  'full-story': ['planning', 'images', 'audio'],
  'full-production': ['planning', 'images', 'audio', 'video'],
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
// Stops at structural decisions instead of silently deciding them: if Planning's scene-count
// recommendation differs from the current target, `runPlanning` halts and returns
// `stoppedAt: 'sceneCountDecision'` unless `autoAcceptRecommendations` is explicitly true (off by
// default) or the caller supplies its own `onSceneCountDecision` (e.g. to drive a real modal
// instead of auto-accepting) — either way, no image/audio/video work starts until that decision is
// resolved one way or another.
export async function runCreateStoryFlow(preset, els, setStatus, { autoAcceptRecommendations = false, stages: customStages, onSceneCountDecision } = {}) {
  flowStopRequested = false;
  const stages = preset === 'custom' ? (customStages || []) : PRESET_STAGES[preset];
  if (!stages || !stages.length) return { stoppedAt: 'noStages' };

  if (stages.includes('planning')) {
    const planningStatus = computeStageStatus(sceneStore.get().scenes, batchStore.get(), uiStore.get().operation, getCachedJobs()).planning;
    // A brand-new project (no scenes at all yet) always needs the full sequence — computeStageStatus
    // reports `missing: 0` for an empty scene list (there's nothing to divide a ratio by), which is
    // NOT the same as "already planned."
    if (planningStatus.missing > 0 || planningStatus.total === 0 || planningStatus.hasChanges) {
      // No plan yet, or an incomplete one, or script/settings changed: run the full sequence
      // (segment -> narrate -> scene count -> prompts), same as a standalone Planning run.
      const decision = onSceneCountDecision || (autoAcceptRecommendations ? async ({ recommended }) => recommended : undefined);
      const planningResult = await runPlanning(els, setStatus, { onSceneCountDecision: decision });
      if (planningResult.stoppedAt) return planningResult;
    } else if (planningStatus.stale > 0) {
      // A complete plan already exists — only its stale prompts need fixing. Never regenerate
      // narration or re-run the whole sequence just because a downstream box was checked.
      await updateStalePlanning(els, setStatus);
    }
    // Both missing and stale are 0: planning is already up to date, nothing to do.
  }
  if (flowStopRequested) return { stoppedAt: 'paused' };

  for (const stage of ['images', 'audio', 'video']) {
    if (!stages.includes(stage)) continue;
    if (flowStopRequested) return { stoppedAt: 'paused', atStage: stage };
    const finalState = await generateMissingOrStale(stage, els, setStatus);
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
const ALL_STAGES = ['planning', 'images', 'audio', 'video'];
const manualSelectionOverride = {};

export function stageHasActionableWork(stage, stageStatus) {
  // A brand-new project has no scenes yet, so every stage's tally reads 0/0/0 — but Planning is
  // still the one stage that always has something to do in that state (it's what creates the
  // scenes). Images/Audio/Video genuinely have nothing to do until scenes exist.
  if (stage === 'planning') {
    if (stageStatus.total === 0 || stageStatus.hasChanges) return true;
  }
  return stageStatus.missing > 0 || stageStatus.stale > 0 || stageStatus.failed > 0;
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
