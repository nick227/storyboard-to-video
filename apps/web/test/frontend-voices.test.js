const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const storePromise = import(path.join(__dirname, '..', 'public', 'modules', 'store.js'));
const voicesPromise = import(path.join(__dirname, '..', 'public', 'modules', 'voices.js'));

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
