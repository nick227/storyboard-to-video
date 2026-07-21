const $ = (id) => document.getElementById(id);

async function errorMessage(response) {
  const data = await response.json().catch(() => ({}));
  return data.error?.message || `Request failed (${response.status})`;
}

async function api(path, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
  const response = await fetch(path, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json();
}

function setStatus(text, error = false) {
  const el = $('ttsStatus');
  el.textContent = text;
  el.classList.toggle('error', error);
}

function addVoiceOption(select, value, text) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = text;
  select.appendChild(option);
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
  select.disabled = true;
  select.innerHTML = '';
  addVoiceOption(select, '', 'Loading voices...');
  try {
    const voices = await loadVoices(provider);
    select.innerHTML = '';
    if (!voices.length) {
      addVoiceOption(select, '', 'No voices available');
      return;
    }
    voices.forEach((voice) => addVoiceOption(select, voice.voiceId, voice.label || voice.voiceId));
  } catch (error) {
    select.innerHTML = '';
    addVoiceOption(select, '', 'Unavailable');
    setStatus(`Could not load ${provider} voices: ${error.message}`, true);
  } finally {
    select.disabled = false;
  }
}

let currentAudioUrl = null;

function showResult(blob, filename) {
  if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
  currentAudioUrl = URL.createObjectURL(blob);
  $('ttsPlayer').src = currentAudioUrl;
  const link = $('ttsDownloadLink');
  link.href = currentAudioUrl;
  link.download = filename;
  $('ttsResult').hidden = false;
}

function downloadFilename(response) {
  const match = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') || '');
  return match ? match[1] : 'speech.wav';
}

$('ttsText').addEventListener('input', () => {
  $('ttsCharCount').textContent = `${$('ttsText').value.length} / 6000`;
});

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
  button.textContent = 'Generating...';
  setStatus('Generating audio...');
  try {
    const response = await fetch('/api/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, provider, voice }),
    });
    if (!response.ok) throw new Error(await errorMessage(response));
    showResult(await response.blob(), downloadFilename(response));
    setStatus('Done.');
  } catch (error) {
    setStatus(`Generation failed: ${error.message}`, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Generate audio';
  }
});

refreshVoiceField();
