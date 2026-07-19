const { signal, throwResponse } = require('../http');

// Alignment is additive to audio generation, never blocking: any failure here (network,
// non-2xx, timeout) is swallowed and normalized to {words: []} so callers never need their own
// network-error handling -- they only need to treat an empty words array as "no karaoke data yet".
function createAlignmentProvider(config, getCancellation) {
  async function align({ audioBuffer, transcript, mimeType }) {
    try {
      const form = new FormData();
      form.append('audio', new Blob([audioBuffer], { type: mimeType || 'audio/wav' }), 'audio.wav');
      form.append('transcript', transcript || '');
      const headers = {};
      if (config.alignServiceToken) headers.Authorization = `Bearer ${config.alignServiceToken}`;
      const response = await fetch(`${config.alignUrl}/align`, { method: 'POST', headers, body: form, signal: signal(config.alignTimeout, getCancellation) });
      if (!response.ok) await throwResponse('alignment', response);
      const body = await response.json();
      return { words: Array.isArray(body.words) ? body.words : [] };
    } catch (error) {
      return { words: [] };
    }
  }
  return { align };
}

module.exports = { createAlignmentProvider };
