const { signal, throwResponse } = require('../providers/http');
const { AppError } = require('../errors');
const { PIPER_VOICE_CATALOG } = require('../config/piper-voices');
const { providerOutput, providerResult } = require('../providers/result');

function createVoiceService(config, getCancellation, audioProvider = {}, usageTracker, providerAdmission) {
  const spark = (name) => `${config.sparkUrl}${name}`;
  const authHeaders = () => config.sparkServiceToken ? { Authorization: `Bearer ${config.sparkServiceToken}` } : {};
  const admit = (provider, operation) => providerAdmission
    ? providerAdmission.run(provider, operation, { signal: getCancellation?.() })
    : operation();
  const tracked = (metadata, operation) => usageTracker ? usageTracker.execute(metadata, operation) : operation();

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
      return providerOutput(await audioProvider.piperPreview(voiceId));
    },
    async sparkPreflight() {
      const result = await admit('spark', () => tracked({ modality: 'audio', provider: 'spark', model: 'spark-preflight' }, async () => {
        const response = await fetch(spark('/health'), { signal: signal(config.env.SPARK_PREFLIGHT_TIMEOUT_MS || 3_000, getCancellation) });
        if (!response.ok) throw new Error(`health check returned HTTP ${response.status}`);
        return providerResult({ output: { ok: true, provider: 'spark' }, provider: 'spark', model: 'spark-preflight', usage: {}, measurementStatus: 'not_applicable' });
      }));
      return providerOutput(result);
    },
    sparkVoices() {
      return admit('spark', async () => {
        const response = await fetch(spark('/voices'), { headers: authHeaders(), signal: signal(config.env.SPARK_PREFLIGHT_TIMEOUT_MS || 10_000, getCancellation) });
        if (!response.ok) throw new Error(`Voice list failed (${response.status})`);
        return (await response.json()).voices?.map((voice) => ({ voiceId: voice.voiceId, label: voice.name })) || [];
      });
    },
    async clone(file, name) {
      const result = await admit('spark', () => tracked({ modality: 'audio', provider: 'spark', model: 'spark-voice-clone', inputMetadata: { fileBytes: file.buffer.length } }, async () => {
        const form = new FormData();
        form.append('audio', new Blob([file.buffer]), file.originalname || 'recording.webm');
        form.append('name', name);
        const response = await fetch(spark('/voices'), { method: 'POST', headers: authHeaders(), body: form, signal: signal(config.env.SPARK_CLONE_TIMEOUT_MS || 60_000, getCancellation) });
        if (!response.ok) {
          const detail = await response.json().catch(() => ({}));
          throw new Error(detail.detail || `Voice cloning failed (${response.status})`);
        }
        const data = await response.json();
        return providerResult({ output: { voiceId: data.voiceId, label: data.name }, provider: 'spark', model: 'spark-voice-clone', usage: { clones: 1, fileBytes: file.buffer.length }, measurementStatus: 'observed' });
      }));
      return providerOutput(result);
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
    async reference(voiceId) {
      const result = await admit('spark', () => tracked({ modality: 'audio', provider: 'spark', model: 'spark-reference' }, async () => {
        const response = await fetch(spark(`/voices/${encodeURIComponent(voiceId)}/reference`), { headers: authHeaders(), signal: signal(config.env.SPARK_PREFLIGHT_TIMEOUT_MS || 10_000, getCancellation) });
        if (!response.ok) throw new Error(`Reference audio failed (${response.status})`);
        const buffer = Buffer.from(await response.arrayBuffer());
        return providerResult({ output: { buffer, contentType: response.headers.get('content-type') || 'audio/wav' }, provider: 'spark', model: 'spark-reference', usage: {}, measurementStatus: 'observed' });
      }));
      return providerOutput(result);
    },
  };
}

module.exports = { createVoiceService };
