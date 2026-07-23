import { batchStore, uiStore, sceneStore } from '../core/store.js';
import { cancelActiveProjectJobs } from '../core/api.js';

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
        currentIndex: Math.min(Math.max(fromIndex, 0), scenes.length)
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
    let failed = false;

    for (let i = batchStore.get()[type].currentIndex; i < scenes.length; i++) {
      if (batchStore.get()[type].stopRequested) {
        stopped = true;
        break;
      }

      batchStore.set((state) => ({ [type]: { ...state[type], currentIndex: i } }));
      const scene = scenes[i];
      uiStore.set({ operation: { type: `${type}Serial`, sceneId: scene.id, trigger }, selectedSceneId: scene.id });
      
      try {
        const skipped = await generateFn(i, scene);
        if (skipped) {
          batchStore.set((state) => ({ [type]: { ...state[type], currentIndex: i + 1 } }));
          continue;
        }
        batchStore.set((state) => ({ [type]: { ...state[type], currentIndex: i + 1 } }));
      } catch (err) {
        stopped = true;
        failed = true;
        break;
      }
    }
    
    // Finalize
    let finalState = 'complete';
    if (failed) finalState = 'failed';
    else if (stopped) finalState = 'paused';
    
    batchStore.set((state) => ({
      [type]: { ...state[type], generating: false, state: finalState }
    }));
    
    uiStore.set({ operation: null });
    
    return finalState; // Callers can use this to update status text
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
    const current = batchStore.get()[type];
    if (!['paused', 'failed'].includes(current.state)) return;
    return this.start(type, generateFn, getScenes, current.currentIndex, 'resume');
  }
};
