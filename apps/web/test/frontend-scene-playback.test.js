const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const renderingPromise = import(path.join(__dirname, '..', 'public', 'js', 'studio', 'rendering.js'));

function fakeEventTarget(properties = {}) {
  const listeners = new Map();
  return {
    ...properties,
    dataset: properties.dataset || {},
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    listenerCount(type) { return listeners.get(type)?.size || 0; },
  };
}

test('replacing scene playback preserves renderer-owned audio and video sources', async () => {
  const { setupScenePlayback } = await renderingPromise;
  const toggle = fakeEventTarget({ disabled: false, hidden: false, setAttribute() {} });
  const video = fakeEventTarget({ duration: 4, currentTime: 0, loop: false, src: 'blob:video', pause() {} });
  const audio = fakeEventTarget({ duration: 6, currentTime: 0, src: 'blob:audio', pause() {} });

  const cleanup = setupScenePlayback({
    toggle,
    video,
    audio,
    hasVideo: true,
    hasAudio: true,
    words: [],
    captionEl: null,
  });

  assert.equal(toggle.listenerCount('click'), 1);
  cleanup();

  assert.equal(video.src, 'blob:video');
  assert.equal(audio.src, 'blob:audio');
  assert.equal(toggle.listenerCount('click'), 0);
});
