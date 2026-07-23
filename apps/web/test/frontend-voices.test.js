const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const storePromise = import(path.join(__dirname, '..', 'public', 'js', 'core', 'store.js'));
const voicesPromise = import(path.join(__dirname, '..', 'public', 'js', 'media', 'voices.js'));

test('refreshVoicesForCurrentProvider loads cloned spark voices into voiceStore', async () => {
  const { voiceStore } = await storePromise;
  const { refreshVoicesForCurrentProvider } = await voicesPromise;

  voiceStore.set({ audioProvider: 'spark', availableVoices: { elevenlabs: [], spark: [], piper: [] } });

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url === '/api/audio/spark/voices') {
      return {
        ok: true,
        text: async () => JSON.stringify({ voices: [{ voiceId: 'custom_v1', label: 'My Custom Voice' }] })
      };
    }
    return { ok: false, text: async () => '{}' };
  };

  try {
    await refreshVoicesForCurrentProvider(null, { force: true });
    assert.deepEqual(voiceStore.get().availableVoices.spark, [{ voiceId: 'custom_v1', label: 'My Custom Voice' }]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('previewVoice plays, updates button callback status, and toggles play/stop on subsequent clicks', async () => {
  const { previewVoice, stopPreviewVoice } = await voicesPromise;

  // Mock fetch, URL.createObjectURL, and Audio
  const originalFetch = global.fetch;
  const originalCreate = URL.createObjectURL;
  const originalAudio = global.Audio;

  global.fetch = async () => {
    return {
      ok: true,
      blob: async () => new Blob(['audio-data'])
    };
  };
  URL.createObjectURL = () => 'blob:mock-audio';

  let playCalled = false;
  let pauseCalled = false;
  let mockAudioInstance = null;

  class MockAudio {
    constructor(src) {
      this.src = src;
      this.listeners = {};
      mockAudioInstance = this;
    }
    addEventListener(event, callback) {
      this.listeners[event] = callback;
    }
    removeEventListener() {}
    play() {
      playCalled = true;
      return Promise.resolve();
    }
    pause() {
      pauseCalled = true;
    }
    trigger(event) {
      if (this.listeners[event]) this.listeners[event]();
    }
  }
  global.Audio = MockAudio;

  try {
    let startCallbackCalled = false;
    let endCallbackCalled = false;

    const onStart = () => { startCallbackCalled = true; };
    const onEnd = () => { endCallbackCalled = true; };

    // First call: start previewing voice
    const voice = { voiceId: 'voice_123', label: 'Test Voice' };
    const previewPromise = previewVoice('spark', voice, null, onStart, onEnd);
    await previewPromise;

    assert.equal(playCalled, true);
    assert.equal(startCallbackCalled, true);
    assert.equal(endCallbackCalled, false);
    assert.equal(pauseCalled, false);

    // Reset flags
    playCalled = false;
    startCallbackCalled = false;

    // Second call with same voice: should stop the playing preview instead of starting again
    await previewVoice('spark', voice, null, onStart, onEnd);

    assert.equal(playCalled, false);
    assert.equal(pauseCalled, true);
    assert.equal(endCallbackCalled, true);

    // Reset flags
    playCalled = false;
    pauseCalled = false;
    startCallbackCalled = false;
    endCallbackCalled = false;

    // Start preview again
    await previewVoice('spark', voice, null, onStart, onEnd);
    assert.equal(playCalled, true);
    assert.equal(startCallbackCalled, true);
    assert.equal(endCallbackCalled, false);

    // Trigger ended event: should call onEnd callback
    mockAudioInstance.trigger('ended');
    assert.equal(endCallbackCalled, true);

  } finally {
    global.fetch = originalFetch;
    URL.createObjectURL = originalCreate;
    global.Audio = originalAudio;
  }
});
