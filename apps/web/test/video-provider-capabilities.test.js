const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { VIDEO_PROVIDER_CAPABILITIES, videoProviderCapabilities } = require('../src/shared/video-provider-capabilities');

test('current video providers advertise model-specific start/end-frame support', () => {
  assert.deepEqual(Object.keys(VIDEO_PROVIDER_CAPABILITIES).sort(), ['ltx', 'minimax', 'stub', 'veo']);
  assert.equal(videoProviderCapabilities('ltx').supportsStartFrame, true);
  assert.equal(videoProviderCapabilities('ltx').supportsEndFrame, false);
  assert.equal(videoProviderCapabilities('minimax', 'video-01', 'image_to_video').supportsStartFrame, true);
  assert.equal(videoProviderCapabilities('minimax', 'video-01', 'image_to_video').supportsEndFrame, false);
  assert.equal(videoProviderCapabilities('minimax', 'MiniMax-Hailuo-02', 'first_last_frame').supportsEndFrame, true);
  assert.equal(videoProviderCapabilities('stub').supportsEndFrame, false);
  assert.equal(videoProviderCapabilities('veo', 'veo-3.1-generate-preview', 'image_to_video').supportsEndFrame, false);
  assert.equal(videoProviderCapabilities('veo', 'veo-3.1-generate-preview', 'first_last_frame').supportsEndFrame, true);
  assert.throws(() => videoProviderCapabilities('sora'), /Unsupported video provider/);
});

test('browser and server use the same video capability flags', async () => {
  const browser = await import(path.join(__dirname, '..', 'public', 'js', 'generation', 'video-provider-capabilities.js'));
  assert.deepEqual(browser.VIDEO_PROVIDER_CAPABILITIES, VIDEO_PROVIDER_CAPABILITIES);
});

test('browser and server resolve identical derived capability flags for every declared provider/model/mode', async () => {
  const browser = await import(path.join(__dirname, '..', 'public', 'js', 'generation', 'video-provider-capabilities.js'));
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
