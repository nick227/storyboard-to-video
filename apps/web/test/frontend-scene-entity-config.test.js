const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const configPromise = import(path.join(__dirname, '..', 'public', 'js', 'core', 'scene-entity-config.js'));

test('scene entity configuration resolves overrides before project defaults', async () => {
  const { resolvedEntityConfig } = await configPromise;
  const record = {
    textProvider: 'gemini',
    imageProvider: 'gemini',
    mediaSettings: {
      aspectRatio: '16:9',
      image: { resolutionTier: 'standard', quality: 'medium' },
      video: { provider: 'ltx', resolutionTier: 'draft', durationSeconds: 4 },
    },
    videoMotionIntensity: 'medium',
    subtitleStyle: 'classic',
  };
  const scene = {
    entityOverrides: {
      image: { provider: 'openai', resolutionTier: 'high', aspectRatio: '1:1', quality: 'high' },
      video: { provider: 'minimax', durationSeconds: 8, motionIntensity: 'subtle' },
      subtitle: { style: 'bold' },
    },
  };

  assert.deepEqual(resolvedEntityConfig(scene, 'image', { record }), {
    provider: 'openai', aspectRatio: '1:1', resolutionTier: 'high', quality: 'high',
  });
  assert.deepEqual(resolvedEntityConfig(scene, 'video', { record }), {
    provider: 'minimax', model: '', aspectRatio: '16:9', resolutionTier: 'draft',
    durationSeconds: 8, motionIntensity: 'subtle',
  });
  assert.deepEqual(resolvedEntityConfig(scene, 'subtitle', { record }), { style: 'bold' });
});

test('clearing a scene entity override restores inheritance without copying defaults', async () => {
  const { clearEntityOverride, hasEntityOverride, setEntityOverride } = await configPromise;
  const scene = {};
  setEntityOverride(scene, 'audio', { provider: 'elevenlabs', voice: { voiceId: 'ava' } });
  assert.equal(hasEntityOverride(scene, 'audio'), true);
  clearEntityOverride(scene, 'audio');
  assert.equal(hasEntityOverride(scene, 'audio'), false);
  assert.deepEqual(scene.entityOverrides, {});
});
