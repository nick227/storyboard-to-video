const test = require('node:test');
const assert = require('node:assert/strict');
const { createTextProviders } = require('../src/providers/text');
const { createImageProviders } = require('../src/providers/image');
const { createAudioProviders } = require('../src/providers/audio');
const { createAlignmentProvider } = require('../src/providers/alignment');
const { createVoiceService } = require('../src/services/voice.service');
const { mergeMediaIntent, resolveImageOutput } = require('../src/shared/media-output-policy');

test('text, image, audio, alignment, and voice API calls share provider admission lanes', async () => {
  const originalFetch = global.fetch;
  const admitted = [];
  const providerAdmission = {
    run(provider, operation) { admitted.push(provider); return operation(); },
  };
  const config = {
    env: {
      OPENAI_API_KEY: 'openai-key', OPENAI_TEXT_MODEL: 'gpt-test', DEZGO_API_KEY: 'dezgo-key',
      ELEVENLABS_API_KEY: 'eleven-key', ELEVENLABS_MODEL_ID: 'eleven-test', ELEVENLABS_OUTPUT_FORMAT: 'pcm_24000',
    },
    paths: { piperVoices: '/tmp', piper: '/tmp/piper' }, piperVoices: [],
    sparkUrl: 'http://spark.test', sparkTimeout: 1_000,
    alignUrl: 'http://align.test', alignTimeout: 1_000,
  };
  try {
    global.fetch = async (url) => {
      const value = String(url);
      if (value.includes('api.openai.com/v1/responses')) return new Response(JSON.stringify({ id: 'text-1', model: 'gpt-test', output_text: 'done' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (value.includes('api.dezgo.com')) return new Response(Buffer.from('png'), { status: 200, headers: { 'Content-Type': 'image/png' } });
      if (value.includes('api.elevenlabs.io')) return new Response(Buffer.from([0, 0, 0, 0]), { status: 200 });
      if (value.includes('align.test')) return new Response(JSON.stringify({ words: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (value.includes('spark.test')) return new Response(JSON.stringify({ voices: [{ voiceId: 'voice-1', name: 'Voice' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      throw new Error(`Unexpected URL: ${value}`);
    };

    const text = createTextProviders(config, () => null, null, providerAdmission);
    await text.call('openai', 'Write a scene.');

    const images = createImageProviders(config, text, () => null, null, providerAdmission);
    const intent = mergeMediaIntent({ modality: 'image' });
    await images.generate({ provider: 'dezgo_flux', prompt: 'Draw a scene.', output: resolveImageOutput({ provider: 'dezgo_flux', model: 'flux_1_schnell', intent }) });

    const audio = createAudioProviders(config, () => null, null, providerAdmission);
    await audio.generate({ provider: 'elevenlabs', narrationText: 'Speak.', voice: { voiceId: 'voice-1' } });

    const alignment = createAlignmentProvider(config, () => null, null, providerAdmission);
    await alignment.align({ audioBuffer: Buffer.from('audio'), transcript: 'Speak.', mimeType: 'audio/wav' });

    const voices = createVoiceService(config, () => null, audio, null, providerAdmission);
    await voices.sparkVoices();

    assert.deepEqual(admitted, ['openai', 'dezgo', 'elevenlabs', 'alignment', 'spark']);
  } finally {
    global.fetch = originalFetch;
  }
});
