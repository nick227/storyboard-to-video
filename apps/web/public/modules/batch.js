import { batchStore, uiStore, sceneStore } from './store.js';
import { cancelActiveProjectJobs } from './api.js';

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
    
    uiStore.set({ operation: { type: `${type}Serial`, sceneId: scenes[batchStore.get()[type].currentIndex]?.id || null, trigger } });
    
    let stopped = false;
    let failed = false;

    for (let i = batchStore.get()[type].currentIndex; i < scenes.length; i++) {
      if (batchStore.get()[type].stopRequested) {
        stopped = true;
        break;
      }
      
      batchStore.set((state) => ({ [type]: { ...state[type], currentIndex: i } }));
      const scene = scenes[i];
      uiStore.set({ operation: { type: `${type}Serial`, sceneId: scene.id, trigger } });
      
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
