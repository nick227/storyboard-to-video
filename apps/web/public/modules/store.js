export class Store {
  constructor(initialState = {}) {
    this.state = initialState;
    this.listeners = new Set();
  }

  get() {
    return this.state;
  }

  set(updater) {
    const newState = typeof updater === 'function' ? updater(this.state) : updater;
    this.state = { ...this.state, ...newState };
    this.emit();
  }

  emit() {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const projectStore = new Store({
  storyboards: [],
  currentId: null,
  version: 3
});

export const sceneStore = new Store({
  scenes: [],
  lastPromptInputs: null
});

export const generationStore = new Store({
  styles: [],
  styleReferences: { characters: [], world: [] }
});

export const voiceStore = new Store({
  audioProvider: 'stub',
  narratorVoice: { elevenlabs: null, piper: null, spark: null, stub: null },
  availableVoices: { elevenlabs: [], spark: [], piper: [] }
});

export const batchStore = new Store({
  images: { state: 'idle', currentIndex: 0, generating: false, stopRequested: false },
  audio: { state: 'idle', currentIndex: 0, generating: false, stopRequested: false },
  videos: { state: 'idle', currentIndex: 0, generating: false, stopRequested: false }
});

export const uiStore = new Store({
  operation: null, // e.g. { type: 'prompt', sceneId: 'xyz' }
  // The run anchor a Start click uses ("Start from Scene N"). Session state only — resets on
  // reload, same convention as stages.js's manualSelectionOverride. Resolved defensively via
  // resolveSelectedSceneIndex (stages.js) wherever it's read, so a stale/removed id never breaks
  // rendering or a run.
  selectedSceneId: null
});

// A helper for global debounced events (e.g., text inputs)
let debounceTimer;
export function debounce(fn, ms = 300) {
  return (...args) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => fn(...args), ms);
  };
}
