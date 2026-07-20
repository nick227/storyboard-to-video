const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { VIDEO_PROVIDER_CAPABILITIES, videoProviderCapabilities } = require('../src/shared/video-provider-capabilities');

test('current video providers advertise start-frame support but no end-frame support for standard models', () => {
  assert.deepEqual(Object.keys(VIDEO_PROVIDER_CAPABILITIES).sort(), ['ltx', 'minimax', 'stub']);
  assert.equal(videoProviderCapabilities('ltx').supportsStartFrame, true);
  assert.equal(videoProviderCapabilities('ltx').supportsEndFrame, false);
  assert.equal(videoProviderCapabilities('minimax', 'video-01', 'image_to_video').supportsStartFrame, true);
  assert.equal(videoProviderCapabilities('minimax', 'video-01', 'image_to_video').supportsEndFrame, false);
  assert.equal(videoProviderCapabilities('minimax', 'video-01-keyframe', 'first_last_frame').supportsEndFrame, true);
  assert.equal(videoProviderCapabilities('stub').supportsEndFrame, false);
  assert.throws(() => videoProviderCapabilities('veo'), /Unsupported video provider/);
});

test('browser and server use the same video capability flags', async () => {
  const browser = await import(path.join(__dirname, '..', 'public', 'modules', 'video-provider-capabilities.js'));
  assert.deepEqual(browser.VIDEO_PROVIDER_CAPABILITIES, VIDEO_PROVIDER_CAPABILITIES);
});

test('browser and server resolve identical derived capability flags for every declared provider/model/mode', async () => {
  const browser = await import(path.join(__dirname, '..', 'public', 'modules', 'video-provider-capabilities.js'));
  for (const [provider, providerCapabilities] of Object.entries(VIDEO_PROVIDER_CAPABILITIES)) {
    for (const [model, modelCapabilities] of Object.entries(providerCapabilities.models)) {
      for (const mode of Object.keys(modelCapabilities.modes)) {
        assert.deepEqual(
          browser.videoProviderCapabilities(provider, model, mode),
          videoProviderCapabilities(provider, model, mode),
          `${provider}/${model}/${mode} capability output diverged between browser and server`
        );
      }
    }
  }
});
