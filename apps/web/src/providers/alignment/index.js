const { signal, throwResponse } = require('../http');
const { providerResult, providerOutput } = require('../result');

// A word is only usable for karaoke highlighting if it has real, ordered timing -- filters out
// anything malformed regardless of whether the service itself already should have (defense in
// depth: a regression in the alignment service shouldn't be able to push garbage into stored
// project documents).
function isUsableWord(word) {
  return word && typeof word.text === 'string' && word.text.length > 0
    && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start;
}

// Alignment is additive to audio generation, never blocking: any failure here (network,
// non-2xx, timeout) is swallowed and normalized to {words: []} so callers never need their own
// network-error handling -- they only need to treat an empty words array as "no karaoke data yet".
// Swallowed failures are still logged, since this is otherwise the only signal an operator gets
// that the alignment service is unreachable or misbehaving.
function createAlignmentProvider(config, getCancellation, usageTracker, providerAdmission) {
  async function align({ audioBuffer, transcript, mimeType }) {
    // Not configured (e.g. no alignment-service deployed to this environment yet) -- skip
    // entirely rather than attempting a call that's guaranteed to fail. No usage/billing record
    // is created either: this was never attempted, not a failed attempt.
    if (!config.alignUrl) return { words: [] };
    try {
      const operation = async () => {
        const form = new FormData();
        form.append('audio', new Blob([audioBuffer], { type: mimeType || 'audio/wav' }), 'audio.wav');
        form.append('transcript', transcript || '');
        const headers = {};
        if (config.alignServiceToken) headers.Authorization = `Bearer ${config.alignServiceToken}`;
        const response = await fetch(`${config.alignUrl}/align`, { method: 'POST', headers, body: form, signal: signal(config.alignTimeout, getCancellation) });
        if (!response.ok) await throwResponse('alignment', response);
        const body = await response.json();
        const words = Array.isArray(body.words) ? body.words.filter(isUsableWord) : [];
        return providerResult({
          output: { words }, provider: 'whisperx', model: 'whisperx-forced-alignment',
          usage: { characters: String(transcript || '').length, audioBytes: audioBuffer.length },
          rawUsage: { wordCount: words.length }, measurementStatus: 'observed',
        });
      };
      const tracked = () => usageTracker ? usageTracker.execute({ modality: 'alignment', provider: 'whisperx', model: 'whisperx-forced-alignment', inputMetadata: { transcriptCharacters: String(transcript || '').length } }, operation) : operation();
      const result = providerAdmission ? await providerAdmission.run('alignment', tracked, { signal: getCancellation?.() }) : await tracked();
      return providerOutput(result);
    } catch (error) {
      console.warn(`Alignment request failed, continuing without karaoke data: ${error.message}`);
      return { words: [] };
    }
  }
  return { align };
}

module.exports = { createAlignmentProvider };
