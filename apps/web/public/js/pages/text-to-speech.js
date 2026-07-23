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
    updatePreviewButtonState();
    return;
  }
  field.hidden = false;
  select.disabled = true;
  select.innerHTML = '';
  addVoiceOption(select, '', 'Loading voices...');
  try {
    const voices = await loadVoices(provider);
    select.innerHTML = '';
    addVoiceOption(select, '', voices.length ? 'Choose a voice...' : 'No voices available');
    if (provider === 'spark') addVoiceOption(select, 'clone', 'Clone voice...');
    voices.forEach((voice) => addVoiceOption(select, voice.voiceId, voice.label || voice.voiceId));
  } catch (error) {
    select.innerHTML = '';
    addVoiceOption(select, '', 'Unavailable');
    setStatus(`Could not load ${provider} voices: ${error.message}`, true);
  } finally {
    select.disabled = false;
    updatePreviewButtonState();
  }
}

// ---- Voice preview (start/stop toggle for piper, spark and ElevenLabs) ----

let previewAudio = null;
let previewVoiceId = null;

function previewSrc(provider, voice) {
  if (provider === 'elevenlabs') return voice.previewUrl || null;
  if (provider === 'spark') return `/api/audio/spark/voices/${encodeURIComponent(voice.voiceId)}/reference`;
  if (provider === 'piper') return `/api/audio/piper/voices/${encodeURIComponent(voice.voiceId)}/preview`;
  return null;
}

function stopPreview() {
  if (previewAudio) previewAudio.pause();
  previewAudio = null;
  previewVoiceId = null;
  const btn = $('ttsPreviewBtn');
  btn.textContent = '▶';
  btn.title = 'Preview the voice';
}

function updatePreviewButtonState() {
  const provider = $('ttsProvider').value;
  const voiceId = $('ttsVoice').value;
  $('ttsPreviewBtn').disabled = provider === 'stub' || !voiceId || voiceId === 'clone';
}

$('ttsPreviewBtn').addEventListener('click', async () => {
  const provider = $('ttsProvider').value;
  const voiceId = $('ttsVoice').value;
  if (!voiceId || voiceId === 'clone') return;

  if (previewAudio && previewVoiceId === voiceId) {
    stopPreview();
    return;
  }
  stopPreview();

  const voice = (voiceCache[provider] || []).find((entry) => entry.voiceId === voiceId);
  const src = voice && previewSrc(provider, voice);
  if (!src) {
    setStatus('No preview available for this voice.', true);
    return;
  }

  previewVoiceId = voiceId;
  previewAudio = new Audio(src);
  previewAudio.addEventListener('ended', stopPreview);
  previewAudio.addEventListener('error', () => { setStatus('Preview failed to load.', true); stopPreview(); });
  const btn = $('ttsPreviewBtn');
  btn.textContent = '■';
  btn.title = 'Stop preview';
  try {
    await previewAudio.play();
  } catch (error) {
    setStatus(`Preview failed: ${error.message}`, true);
    stopPreview();
  }
});

// ---- Clone voice modal (same design as the Studio voice library) ----

const cloneRecording = {
  monitorStream: null, audioContext: null, analyser: null, animationFrameId: null,
  mediaRecorder: null, chunks: [], recordedBlob: null,
};

function drawWaveform() {
  const analyser = cloneRecording.analyser;
  if (!analyser) return;
  const canvas = $('cloneWaveformCanvas');
  const ctx = canvas.getContext('2d');
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#4f8cff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  const sliceWidth = canvas.width / data.length;
  let x = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i] / 128.0;
    const y = (v * canvas.height) / 2;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    x += sliceWidth;
  }
  ctx.lineTo(canvas.width, canvas.height / 2);
  ctx.stroke();
  cloneRecording.animationFrameId = requestAnimationFrame(drawWaveform);
}

function stopMonitorStream() {
  if (cloneRecording.animationFrameId) {
    cancelAnimationFrame(cloneRecording.animationFrameId);
    cloneRecording.animationFrameId = null;
  }
  if (cloneRecording.monitorStream) cloneRecording.monitorStream.getTracks().forEach((track) => track.stop());
  cloneRecording.monitorStream = null;
  if (cloneRecording.audioContext && cloneRecording.audioContext.state !== 'closed') cloneRecording.audioContext.close().catch(() => {});
  cloneRecording.audioContext = null;
  cloneRecording.analyser = null;
  $('cloneWaveformCanvas').getContext('2d').clearRect(0, 0, $('cloneWaveformCanvas').width, $('cloneWaveformCanvas').height);
}

function attachMonitorStream(stream) {
  stopMonitorStream();
  cloneRecording.monitorStream = stream;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AudioContextClass();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  cloneRecording.audioContext = audioContext;
  cloneRecording.analyser = analyser;
  cloneRecording.animationFrameId = requestAnimationFrame(drawWaveform);
  const track = stream.getAudioTracks()[0];
  $('cloneMicStatus').textContent = `Listening on: ${track?.label || 'selected microphone'} — speak to test`;
  $('cloneRecordBtn').disabled = false;
}

async function populateMicList(activeDeviceId) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mics = devices.filter((device) => device.kind === 'audioinput');
  const select = $('cloneMicSelect');
  select.innerHTML = '';
  mics.forEach((mic, index) => {
    const option = document.createElement('option');
    option.value = mic.deviceId;
    option.textContent = mic.label || `Microphone ${index + 1}`;
    select.appendChild(option);
  });
  if (activeDeviceId) select.value = activeDeviceId;
}

async function switchMicrophone(deviceId) {
  $('cloneMicStatus').textContent = 'Switching microphone...';
  $('cloneRecordBtn').disabled = true;
  try {
    attachMonitorStream(await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } }));
  } catch (error) {
    $('cloneMicStatus').textContent = `Microphone access failed: ${error.message}`;
  }
}

async function initMicMonitor() {
  $('cloneMicStatus').textContent = 'Requesting microphone access...';
  $('cloneRecordBtn').disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    await populateMicList(stream.getAudioTracks()[0]?.getSettings().deviceId || '');
    attachMonitorStream(stream);
  } catch (error) {
    $('cloneMicStatus').textContent = `Microphone access failed: ${error.message}`;
  }
}

function resetRecordingUI() {
  const preview = $('cloneRecordPreview');
  preview.hidden = true;
  preview.removeAttribute('src');
  const durationNote = $('cloneDurationNote');
  durationNote.hidden = true;
  durationNote.textContent = '';
  $('cloneSaveBtn').disabled = true;
  $('cloneNameInput').value = '';
  cloneRecording.recordedBlob = null;
}

function toggleRecording() {
  const rec = cloneRecording;
  if (rec.mediaRecorder && rec.mediaRecorder.state === 'recording') {
    rec.mediaRecorder.stop();
    return;
  }
  if (!rec.monitorStream) return;
  resetRecordingUI();
  rec.chunks = [];
  const mediaRecorder = new MediaRecorder(rec.monitorStream);
  rec.mediaRecorder = mediaRecorder;
  mediaRecorder.ondataavailable = (event) => { if (event.data.size) rec.chunks.push(event.data); };
  mediaRecorder.onstop = () => {
    const blob = new Blob(rec.chunks, { type: 'audio/webm' });
    rec.recordedBlob = blob;
    const preview = $('cloneRecordPreview');
    preview.src = URL.createObjectURL(blob);
    preview.hidden = false;
    preview.addEventListener('loadedmetadata', () => {
      const seconds = preview.duration;
      const durationNote = $('cloneDurationNote');
      durationNote.hidden = false;
      durationNote.textContent = Number.isFinite(seconds)
        ? `Recorded ${seconds.toFixed(1)}s${seconds < 10 ? ' — for best quality, aim for 10-15s' : ''}`
        : '';
    }, { once: true });
    $('cloneSaveBtn').disabled = false;
    $('cloneRecordBtn').textContent = 'Record';
  };
  mediaRecorder.start();
  $('cloneRecordBtn').textContent = 'Stop recording';
}

function renderCloneVoiceList() {
  const list = $('cloneVoiceList');
  const voices = voiceCache.spark || [];
  list.innerHTML = '';
  if (!voices.length) {
    const empty = document.createElement('div');
    empty.className = 'voice-library-empty';
    empty.textContent = 'No cloned voices yet.';
    list.appendChild(empty);
    return;
  }
  voices.forEach((voice) => {
    const row = document.createElement('div');
    row.className = 'voice-library-item';
    const label = document.createElement('span');
    label.className = 'voice-library-name';
    label.textContent = voice.label || voice.voiceId;
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = `/api/audio/spark/voices/${encodeURIComponent(voice.voiceId)}/reference`;
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'secondary text-button';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => deleteClonedVoice(voice.voiceId, voice.label));
    row.append(label, audio, deleteBtn);
    list.appendChild(row);
  });
}

async function deleteClonedVoice(voiceId, label) {
  if (!window.confirm(`Delete the voice "${label || voiceId}"? This cannot be undone.`)) return;
  try {
    await api(`/api/audio/spark/voices/${encodeURIComponent(voiceId)}`, { method: 'DELETE' });
    voiceCache.spark = (voiceCache.spark || []).filter((voice) => voice.voiceId !== voiceId);
    renderCloneVoiceList();
    if ($('ttsProvider').value === 'spark') {
      const wasSelected = $('ttsVoice').value === voiceId;
      await refreshVoiceField();
      if (wasSelected) stopPreview();
    }
  } catch (error) {
    setStatus(`Voice delete failed: ${error.message}`, true);
  }
}

async function openCloneModal() {
  try {
    await loadVoices('spark');
  } catch (error) {
    setStatus(`Could not load cloned voices: ${error.message}`, true);
  }
  renderCloneVoiceList();
  resetRecordingUI();
  $('cloneVoiceModal').showModal();
  await initMicMonitor();
}

function closeCloneModalCleanup() {
  const rec = cloneRecording;
  if (rec.mediaRecorder && rec.mediaRecorder.state !== 'inactive') rec.mediaRecorder.stop();
  rec.mediaRecorder = null;
  rec.chunks = [];
  stopMonitorStream();
  resetRecordingUI();
}

$('closeCloneModalBtn').addEventListener('click', () => $('cloneVoiceModal').close());
$('cloneVoiceModal').addEventListener('click', (event) => {
  if (event.target === $('cloneVoiceModal')) $('cloneVoiceModal').close();
});
$('cloneVoiceModal').addEventListener('close', closeCloneModalCleanup);
$('cloneMicSelect').addEventListener('change', () => switchMicrophone($('cloneMicSelect').value));
$('cloneRecordBtn').addEventListener('click', toggleRecording);

$('cloneSaveBtn').addEventListener('click', async () => {
  const blob = cloneRecording.recordedBlob;
  if (!blob) return;
  const name = $('cloneNameInput').value.trim();
  if (!name) {
    setStatus('Enter a name for this voice before saving.', true);
    return;
  }
  const saveBtn = $('cloneSaveBtn');
  saveBtn.disabled = true;
  try {
    const form = new FormData();
    form.append('audio', blob, 'recording.webm');
    form.append('name', name);
    const response = await fetch('/api/audio/spark/voices', { method: 'POST', body: form });
    if (!response.ok) throw new Error(await errorMessage(response));
    const { voice } = await response.json();
    voiceCache.spark = [...(voiceCache.spark || []), voice];
    resetRecordingUI();
    renderCloneVoiceList();
    if ($('ttsProvider').value === 'spark') {
      await refreshVoiceField();
      $('ttsVoice').value = voice.voiceId;
      $('ttsVoice').dataset.lastValue = voice.voiceId;
      updatePreviewButtonState();
    }
    setStatus(`Voice "${name}" added to the library.`);
  } catch (error) {
    setStatus(`Voice cloning failed: ${error.message}`, true);
    saveBtn.disabled = false;
  }
});

// ---- Form wiring ----

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

$('ttsProvider').addEventListener('change', async () => {
  stopPreview();
  await refreshVoiceField();
});

$('ttsVoice').addEventListener('change', () => {
  const select = $('ttsVoice');
  if (select.value === 'clone') {
    select.value = select.dataset.lastValue || '';
    openCloneModal();
    return;
  }
  select.dataset.lastValue = select.value;
  stopPreview();
  updatePreviewButtonState();
});

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

  stopPreview();
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
