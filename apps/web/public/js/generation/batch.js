import { batchStore, uiStore, sceneStore } from '../core/store.js';
import { cancelActiveProjectJobs } from '../core/api.js';

const EMPTY_RESULTS = Object.freeze({ done: [], skipped: [], failed: [] });

// generateFn resolves to the structured shape ({ outcome: 'done'|'skipped'|'failed', reason? }) for
// every outcome the batch should keep moving past — a plain boolean is also accepted for simplicity
// in tests and any not-yet-migrated caller (`true` = skipped, falsy = done). A THROWN error is a
// different thing entirely and is never normalized here — see the loop below.
function normalizeOutcome(value) {
  if (value && typeof value === 'object' && value.outcome) return value;
  return value ? { outcome: 'skipped' } : { outcome: 'done' };
}

export const batchController = {
  async start(type, generateFn, getScenes, fromIndex = 0, trigger = 'start') {
    const scenes = getScenes();
    if (!scenes.length) return;

    // We update batchStore for this specific type (e.g. 'images', 'audio')
    const currentBatch = batchStore.get()[type] || { state: 'idle', currentIndex: 0, generating: false, stopRequested: false };
    if (currentBatch.generating || uiStore.get().operation) return;

    batchStore.set((state) => ({
      [type]: {
        generating: true,
        stopRequested: false,
        state: 'running',
        currentIndex: Math.min(Math.max(fromIndex, 0), scenes.length),
        // Reset every run (start, resume, or a retry-failed pass) — the results panel always shows
        // what THIS run did, not a merged history across runs.
        results: { done: [], skipped: [], failed: [] },
        errorMessage: null,
      }
    }));

    // selectedSceneId is kept in lockstep with operation.sceneId throughout the run — the "busy"
    // (blue) and "selected" (yellow) card borders are meant to move together while a run is active
    // (see .scene-card.is-selected.is-busy in styles.css, a combined state that only makes sense if
    // both track the same scene). This is a live, continuous "which scene is processing right now"
    // signal; runStageBatch's own landing-scene correction (stages.js) still runs after the batch
    // stops to precisely resolve the resume point, which can differ by one from wherever this loop
    // last pointed (committed vs. not-yet-committed), so that logic is unchanged and still wins last.
    const initialScene = scenes[batchStore.get()[type].currentIndex];
    uiStore.set({ operation: { type: `${type}Serial`, sceneId: initialScene?.id || null, trigger }, selectedSceneId: initialScene?.id ?? uiStore.get().selectedSceneId });

    let stopped = false;
    let errorMessage = null;

    for (let i = batchStore.get()[type].currentIndex; i < scenes.length; i++) {
      if (batchStore.get()[type].stopRequested) {
        stopped = true;
        break;
      }

      batchStore.set((state) => ({ [type]: { ...state[type], currentIndex: i } }));
      const scene = scenes[i];
      uiStore.set({ operation: { type: `${type}Serial`, sceneId: scene.id, trigger }, selectedSceneId: scene.id });

      let outcome;
      try {
        outcome = normalizeOutcome(await generateFn(i, scene));
      } catch (err) {
        // generateFn only throws for a SYSTEMIC failure now — an ordinary bad scene or expected
        // provider rejection comes back as a structured { outcome: 'failed' } instead (see
        // workflows.js's isExpectedGenerationRejection) and never reaches here. A throw means the run
        // itself can't be trusted — a server 5xx, a network/storage/DB/queue failure, or a genuinely
        // unexpected exception — so it stops the WHOLE batch immediately rather than burning through
        // the rest of the range against whatever's actually broken. currentIndex deliberately does
        // NOT advance past this scene (it was never actually resolved, just abandoned mid-attempt),
        // so the next Start naturally retries it — same "stopped before committing" landing as an
        // explicit Stop that lands mid-request (see stages.js's runStageBatch), and per the "never
        // auto-retry" rule that retry only ever happens from an explicit, later user action.
        stopped = true;
        errorMessage = err.message;
        break;
      }

      batchStore.set((state) => {
        const bucket = outcome.outcome === 'skipped' ? 'skipped' : outcome.outcome === 'failed' ? 'failed' : 'done';
        const entry = { sceneId: scene.id, ...(outcome.reason ? { reason: outcome.reason } : {}) };
        return {
          [type]: {
            ...state[type],
            currentIndex: i + 1,
            results: { ...state[type].results, [bucket]: [...(state[type].results?.[bucket] || []), entry] },
          }
        };
      });
    }

    // 'error' is distinct from 'paused' — both stop the run and are equally resumable, but 'error'
    // means the run stopped itself because something systemic broke, not because the user asked it
    // to. Callers use this to show a materially different message (and should not quietly say "Done"
    // or a generic "Stopped").
    const finalState = errorMessage ? 'error' : stopped ? 'paused' : 'complete';

    batchStore.set((state) => ({
      [type]: { ...state[type], generating: false, state: finalState, errorMessage }
    }));

    uiStore.set({ operation: null });

    return { finalState, results: batchStore.get()[type].results || EMPTY_RESULTS, errorMessage };
  },

  stop(type, projectId) {
    batchStore.set((state) => ({
      [type]: { ...state[type], stopRequested: true }
    }));
    if (projectId) {
      void cancelActiveProjectJobs(projectId);
    }
  },

  resume(type, generateFn, getScenes) {
    // Both 'paused' (explicit Stop) and 'error' (a systemic failure stopped the run) are resumable —
    // the difference is only in why the run stopped, not whether continuing from currentIndex is safe.
    const current = batchStore.get()[type];
    if (!['paused', 'error'].includes(current.state)) return;
    return this.start(type, generateFn, getScenes, current.currentIndex, 'resume');
  }
};
