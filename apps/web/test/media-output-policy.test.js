const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PLATFORM_MEDIA_DEFAULTS, mergeMediaIntent, resolveImageOutput, resolveVideoOutput,
} = require('../src/shared/media-output-policy');

test('media intent applies platform, user, project, and request precedence without coupling quality to resolution', () => {
  const intent = mergeMediaIntent({
    modality: 'image',
    user: { aspectRatio: '16:9', image: { resolutionTier: 'high', quality: 'low' } },
    project: { aspectRatio: '4:3', image: { quality: 'medium' } },
    override: { image: { resolutionTier: 'ultra' } },
  });
  assert.deepEqual(intent, { aspectRatio: '4:3', resolutionTier: 'ultra', quality: 'medium' });
});

test('platform defaults preserve legacy image and video dimensions', () => {
  const imageIntent = mergeMediaIntent({ modality: 'image', platform: PLATFORM_MEDIA_DEFAULTS });
  const videoIntent = mergeMediaIntent({ modality: 'video', platform: PLATFORM_MEDIA_DEFAULTS });
  const image = resolveImageOutput({ provider: 'openai', model: 'gpt-image-1', intent: imageIntent });
  const video = resolveVideoOutput({ provider: 'ltx', model: 'ltx-video', intent: videoIntent });
  assert.equal(image.resolved.providerSettings.size, '1024x1024');
  assert.deepEqual([video.resolved.width, video.resolved.height], [640, 480]);
});

test('provider-specific image resolution is explicit and unsupported combinations are rejected', () => {
  const intent = mergeMediaIntent({ modality: 'image', override: { aspectRatio: '16:9', image: { resolutionTier: 'high' } } });
  const gemini = resolveImageOutput({ provider: 'gemini', model: 'gemini-3.1-flash-image', intent });
  assert.deepEqual(gemini.resolved.providerSettings, { imageSize: '2K', aspectRatio: '16:9' });
  assert.throws(() => resolveImageOutput({ provider: 'openai', model: 'gpt-image-1', intent }), (error) => error.code === 'UNSUPPORTED_MEDIA_OUTPUT');
});

test('video resolution respects provider/model/duration tuples without downgrading', () => {
  const intent = mergeMediaIntent({ modality: 'video', override: { aspectRatio: '16:9', video: { resolutionTier: 'high', durationSeconds: 6 } } });
  const minimax = resolveVideoOutput({ provider: 'minimax', model: 'MiniMax-Hailuo-02', mode: 'first_last_frame', intent });
  assert.deepEqual(minimax.resolved.providerSettings, { resolution: '1080P', duration: 6 });
  assert.throws(() => resolveVideoOutput({ provider: 'minimax', model: 'MiniMax-Hailuo-02', mode: 'first_last_frame', intent: { ...intent, durationSeconds: 10 } }), (error) => error.code === 'UNSUPPORTED_MEDIA_OUTPUT');
});

test('two-second test clips are supported only by providers that can actually produce them', () => {
  const intent = mergeMediaIntent({ modality: 'video', override: { aspectRatio: '16:9', video: { resolutionTier: 'draft', durationSeconds: 2 } } });
  const ltx = resolveVideoOutput({ provider: 'ltx', model: 'ltx-video', intent });
  assert.equal(ltx.resolved.durationSeconds, 2);
  assert.equal(ltx.resolved.providerSettings.duration, 2);
  assert.throws(
    () => resolveVideoOutput({ provider: 'minimax', model: 'MiniMax-Hailuo-02', intent }),
    (error) => error.code === 'UNSUPPORTED_MEDIA_OUTPUT',
  );
});

test('the platform default draft resolution tier maps Hailuo to the economy 512P test preset', () => {
  const draftIntent = mergeMediaIntent({ modality: 'video', platform: PLATFORM_MEDIA_DEFAULTS });
  assert.equal(draftIntent.resolutionTier, 'draft');
  const minimax = resolveVideoOutput({ provider: 'minimax', model: 'video-01', intent: draftIntent });
  assert.deepEqual(minimax.resolved.providerSettings, { resolution: '720P', duration: 6 });
  const hailuo = resolveVideoOutput({ provider: 'minimax', model: 'MiniMax-Hailuo-02', mode: 'image_to_video', intent: draftIntent });
  assert.deepEqual(hailuo.resolved.providerSettings, { resolution: '512P', duration: 6 });
  assert.throws(
    () => resolveVideoOutput({ provider: 'minimax', model: 'MiniMax-Hailuo-02', mode: 'first_last_frame', intent: draftIntent }),
    (error) => error.code === 'UNSUPPORTED_MEDIA_OUTPUT',
  );
  assert.throws(() => resolveVideoOutput({ provider: 'minimax', model: 'video-01-keyframe', mode: 'first_last_frame', intent: draftIntent }), (error) => error.code === 'UNSUPPORTED_MEDIA_OUTPUT');
});

test('Hailuo economy 512P accepts 6s and 10s without upgrading to 768P', () => {
  const six = resolveVideoOutput({
    provider: 'minimax', model: 'MiniMax-Hailuo-02', mode: 'image_to_video',
    intent: mergeMediaIntent({ modality: 'video', override: { aspectRatio: '16:9', video: { resolutionTier: 'draft', durationSeconds: 6 } } }),
  });
  assert.deepEqual(six.resolved.providerSettings, { resolution: '512P', duration: 6 });
  const ten = resolveVideoOutput({
    provider: 'minimax', model: 'MiniMax-Hailuo-02', mode: 'image_to_video',
    intent: mergeMediaIntent({ modality: 'video', override: { aspectRatio: '16:9', video: { resolutionTier: 'draft', durationSeconds: 10 } } }),
  });
  assert.deepEqual(ten.resolved.providerSettings, { resolution: '512P', duration: 10 });
  const production = resolveVideoOutput({
    provider: 'minimax', model: 'MiniMax-Hailuo-02', mode: 'image_to_video',
    intent: mergeMediaIntent({ modality: 'video', override: { aspectRatio: '16:9', video: { resolutionTier: 'standard', durationSeconds: 6 } } }),
  });
  assert.deepEqual(production.resolved.providerSettings, { resolution: '768P', duration: 6 });
});

test('local-safetensors maps image quality to three step counts', () => {
  const low = resolveImageOutput({
    provider: 'local-safetensors',
    model: 'biglove-xl1',
    intent: mergeMediaIntent({ modality: 'image', override: { image: { quality: 'low' } } }),
  });
  const medium = resolveImageOutput({
    provider: 'local-safetensors',
    model: 'biglove-xl1',
    intent: mergeMediaIntent({ modality: 'image', override: { image: { quality: 'medium' } } }),
  });
  const high = resolveImageOutput({
    provider: 'local-safetensors',
    model: 'biglove-xl1',
    intent: mergeMediaIntent({ modality: 'image', override: { image: { quality: 'high' } } }),
  });
  assert.equal(low.resolved.providerSettings.steps, 8);
  assert.equal(medium.resolved.providerSettings.steps, 30);
  assert.equal(high.resolved.providerSettings.steps, 60);

  const lightningHigh = resolveImageOutput({
    provider: 'local-safetensors',
    model: 'dreamshaper-xl-lightning',
    intent: mergeMediaIntent({ modality: 'image', override: { image: { quality: 'high' } } }),
  });
  assert.equal(lightningHigh.resolved.providerSettings.steps, 60);
});

test('a video provider with no registered output resolver fails clearly instead of a generic dimension error', () => {
  const intent = mergeMediaIntent({ modality: 'video', platform: PLATFORM_MEDIA_DEFAULTS });
  assert.throws(
    () => resolveVideoOutput({ provider: 'sora', model: 'sora-2', intent }),
    (error) => error.code === 'UNSUPPORTED_MEDIA_OUTPUT' && /no video output resolver is registered/i.test(error.message)
  );
});

test('Veo only accepts its documented aspect ratios, resolutions, and durations', () => {
  const landscape = resolveVideoOutput({
    provider: 'veo', model: 'veo-3.1-generate-preview',
    intent: mergeMediaIntent({ modality: 'video', override: { aspectRatio: '16:9', video: { resolutionTier: 'high' } } }),
  });
  assert.deepEqual(landscape.resolved.providerSettings, { aspectRatio: '16:9', resolution: '1080p', duration: 8 });

  const draft = resolveVideoOutput({
    provider: 'veo', model: 'veo-3.1-generate-preview',
    intent: mergeMediaIntent({ modality: 'video', override: { aspectRatio: '9:16', video: { resolutionTier: 'draft' } } }),
  });
  assert.deepEqual(draft.resolved.providerSettings, { aspectRatio: '9:16', resolution: '720p', duration: 6 });

  // Veo only documents 16:9 and 9:16; every other aspect ratio in this app's vocabulary is rejected.
  assert.throws(
    () => resolveVideoOutput({ provider: 'veo', model: 'veo-3.1-generate-preview', intent: mergeMediaIntent({ modality: 'video', override: { aspectRatio: '4:3' } }) }),
    (error) => error.code === 'UNSUPPORTED_MEDIA_OUTPUT'
  );
  // 1080p/4k require exactly 8 seconds; a conflicting explicit duration is rejected rather than
  // silently coerced.
  assert.throws(
    () => resolveVideoOutput({ provider: 'veo', model: 'veo-3.1-generate-preview', intent: mergeMediaIntent({ modality: 'video', override: { aspectRatio: '16:9', video: { resolutionTier: 'ultra', durationSeconds: 4 } } }) }),
    (error) => error.code === 'UNSUPPORTED_MEDIA_OUTPUT'
  );
});
