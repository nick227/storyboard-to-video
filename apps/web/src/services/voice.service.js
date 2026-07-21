const { signal, throwResponse } = require('../providers/http');
const { AppError } = require('../errors');
const { PIPER_VOICE_CATALOG } = require('../config/piper-voices');
const { providerOutput } = require('../providers/result');

function createVoiceService(config, getCancellation, audioProvider = {}, providerAdmission) {
  const spark = (name) => `${config.sparkUrl}${name}`;
  const authHeaders = () => config.sparkServiceToken ? { Authorization: `Bearer ${config.sparkServiceToken}` } : {};
  const admit = (provider, operation) => providerAdmission
    ? providerAdmission.run(provider, operation, { signal: getCancellation?.() })
    : operation();

  return {
    elevenLabsVoices() {
      return admit('elevenlabs', async () => {
        if (!config.env.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY missing');
        const response = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': config.env.ELEVENLABS_API_KEY }, signal: signal(config.env.AUDIO_PROVIDER_TIMEOUT_MS || 60_000, getCancellation) });
        if (!response.ok) await throwResponse('elevenlabs', response);
        return (await response.json()).voices?.map((voice) => ({ voiceId: voice.voice_id, label: voice.name, previewUrl: voice.preview_url || null })) || [];
      });
    },
    piperVoices() {
      return config.piperVoices.map((id) => ({ voiceId: id, label: PIPER_VOICE_CATALOG.find((voice) => voice.id === id)?.label || id }));
    },
    async piperPreview(voiceId) {
      if (!config.piperVoices.includes(voiceId)) throw new AppError('UNKNOWN_VOICE', 'Unknown Piper voice', { status: 404 });
      return audioProvider.piperPreview(voiceId);
    },
    sparkPreflight() {
      return admit('spark', async () => {
        const response = await fetch(spark('/health'), { signal: signal(config.env.SPARK_PREFLIGHT_TIMEOUT_MS || 3_000, getCancellation) });
        if (!response.ok) throw new Error(`health check returned HTTP ${response.status}`);
        return { ok: true, provider: 'spark' };
      });
    },
    sparkVoices() {
      return admit('spark', async () => {
        const response = await fetch(spark('/voices'), { headers: authHeaders(), signal: signal(config.env.SPARK_PREFLIGHT_TIMEOUT_MS || 10_000, getCancellation) });
        if (!response.ok) throw new Error(`Voice list failed (${response.status})`);
        return (await response.json()).voices?.map((voice) => ({ voiceId: voice.voiceId, label: voice.name })) || [];
      });
    },
    clone(file, name) {
      return admit('spark', async () => {
        const form = new FormData();
        form.append('audio', new Blob([file.buffer]), file.originalname || 'recording.webm');
        form.append('name', name);
        const response = await fetch(spark('/voices'), { method: 'POST', headers: authHeaders(), body: form, signal: signal(config.env.SPARK_CLONE_TIMEOUT_MS || 60_000, getCancellation) });
        if (!response.ok) {
          const detail = await response.json().catch(() => ({}));
          throw new Error(detail.detail || `Voice cloning failed (${response.status})`);
        }
        const data = await response.json();
        return { voiceId: data.voiceId, label: data.name };
      });
    },
    remove(voiceId) {
      return admit('spark', async () => {
        const response = await fetch(spark(`/voices/${encodeURIComponent(voiceId)}`), { method: 'DELETE', headers: authHeaders(), signal: signal(config.env.SPARK_PREFLIGHT_TIMEOUT_MS || 10_000, getCancellation) });
        if (!response.ok) throw new Error(`Voice deletion failed (${response.status})`);
      });
    },
    async speak({ provider, text, voice }) {
      return providerOutput(await audioProvider.generate({ provider, narrationText: text, voice }));
    },
    reference(voiceId) {
      return admit('spark', async () => {
        const response = await fetch(spark(`/voices/${encodeURIComponent(voiceId)}/reference`), { headers: authHeaders(), signal: signal(config.env.SPARK_PREFLIGHT_TIMEOUT_MS || 10_000, getCancellation) });
        if (!response.ok) throw new Error(`Reference audio failed (${response.status})`);
        return { buffer: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') || 'audio/wav' };
      });
    },
  };
}

module.exports = { createVoiceService };
