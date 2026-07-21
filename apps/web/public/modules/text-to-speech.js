const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
  const response = await fetch(path, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Request failed (${response.status})`);
  return data;
}

function setStatus(text, error = false) {
  const el = $('ttsStatus');
  el.textContent = text;
  el.classList.toggle('error', error);
}

const voiceCache = {};

async function loadVoices(provider) {
  if (voiceCache[provider]) return voiceCache[provider];
  const voices = provider === 'spark'
    ? (await api('/api/audio/spark/voices')).voices || []
    : (await api(`/api/audio/voices?provider=${encodeURIComponent(provider)}`)).voices || [];
  voiceCache[provider] = voices;
  return voices;
}

async function refreshVoiceField() {
  const provider = $('ttsProvider').value;
  const field = $('ttsVoiceField');
  const select = $('ttsVoice');
  if (provider === 'stub') {
    field.hidden = true;
    select.innerHTML = '';
    return;
  }
  field.hidden = false;
  select.innerHTML = '<option value="">Loading voices...</option>';
  select.disabled = true;
  try {
    const voices = await loadVoices(provider);
    select.disabled = false;
    if (!voices.length) {
      select.innerHTML = '<option value="">No voices available</option>';
      return;
    }
    select.innerHTML = voices.map((voice) => `<option value="${voice.voiceId}">${voice.label || voice.voiceId}</option>`).join('');
  } catch (error) {
    select.innerHTML = '<option value="">Unavailable</option>';
    setStatus(`Could not load ${provider} voices: ${error.message}`, true);
  }
}

$('ttsProvider').addEventListener('change', refreshVoiceField);

$('ttsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = $('ttsText').value.trim();
  if (!text) return;
  const provider = $('ttsProvider').value;
  const voiceSelect = $('ttsVoice');
  const voiceId = provider !== 'stub' ? voiceSelect.value : '';
  if (provider !== 'stub' && !voiceId) {
    setStatus('Choose a voice first.', true);
    return;
  }
  const voice = voiceId ? { voiceId, label: voiceSelect.selectedOptions[0]?.textContent || voiceId } : null;

  const button = $('ttsGenerateBtn');
  button.disabled = true;
  setStatus('Generating audio...');
  try {
    const response = await fetch('/api/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, provider, voice }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error?.message || `Request failed (${response.status})`);
    }
    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') || '';
    const match = /filename="([^"]+)"/.exec(disposition);
    const filename = match ? match[1] : 'speech.wav';
    const url = URL.createObjectURL(blob);

    const player = $('ttsPlayer');
    player.src = url;
    const link = $('ttsDownloadLink');
    link.href = url;
    link.download = filename;
    $('ttsResult').hidden = false;
    setStatus('Done.');
  } catch (error) {
    setStatus(`Generation failed: ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
});

refreshVoiceField();
