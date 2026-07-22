const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const modulePromise = import(path.join(__dirname, '..', 'public', 'modules', 'media-settings.js'));

test('selectedMediaSettings normalizes the media controls into an output intent', async () => {
  const { selectedMediaSettings } = await modulePromise;
  const elements = {
    aspectRatio: { value: '16:9' },
    imageResolutionTier: { value: 'high' },
    imageQuality: { value: 'premium' },
    videoResolutionTier: { value: '1080p' },
    videoDurationSeconds: { value: '8' },
    videoProvider: { value: 'minimax' },
  };

  assert.deepEqual(selectedMediaSettings(elements), {
    version: 1,
    aspectRatio: '16:9',
    image: { resolutionTier: 'high', quality: 'premium' },
    video: { resolutionTier: '1080p', durationSeconds: 8, provider: 'minimax' },
  });
});

test('selectedMediaSettings can explicitly clear an inherited video duration', async () => {
  const { selectedMediaSettings } = await modulePromise;
  const elements = {
    aspectRatio: { value: '' },
    imageResolutionTier: { value: 'standard' },
    imageQuality: { value: 'standard' },
    videoResolutionTier: { value: '720p' },
    videoDurationSeconds: { value: '' },
    videoProvider: { value: '' },
  };

  assert.deepEqual(selectedMediaSettings(elements, { clearInheritedDuration: true }), {
    version: 1,
    image: { resolutionTier: 'standard', quality: 'standard' },
    video: { resolutionTier: '720p', durationSeconds: null },
  });
});

test('initMediaSettings tolerates an entirely absent optional UI', async () => {
  const { initMediaSettings } = await modulePromise;
  const controller = initMediaSettings({});

  assert.equal(typeof controller.refreshAll, 'function');
  await controller.refreshAll();
});
