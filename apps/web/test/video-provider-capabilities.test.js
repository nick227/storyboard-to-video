const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { VIDEO_PROVIDER_CAPABILITIES, videoProviderCapabilities } = require('../src/shared/video-provider-capabilities');

test('current video providers advertise start-frame support but no end-frame support', () => {
  assert.deepEqual(Object.keys(VIDEO_PROVIDER_CAPABILITIES).sort(), ['ltx', 'stub']);
  assert.equal(videoProviderCapabilities('ltx').supportsStartFrame, true);
  assert.equal(videoProviderCapabilities('ltx').supportsEndFrame, false);
  assert.equal(videoProviderCapabilities('stub').supportsEndFrame, false);
  assert.throws(() => videoProviderCapabilities('veo'), /Unsupported video provider/);
});

test('browser and server use the same video capability flags', async () => {
  const browser = await import(path.join(__dirname, '..', 'public', 'modules', 'video-provider-capabilities.js'));
  assert.deepEqual(browser.VIDEO_PROVIDER_CAPABILITIES, VIDEO_PROVIDER_CAPABILITIES);
});
