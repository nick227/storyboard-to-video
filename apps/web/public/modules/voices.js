import { api } from './api.js';
import { voiceStore, projectStore } from './store.js';
import { queueSync } from './persistence.js';
import { loadProtectedAsset } from './assets.js';

export const voiceRecordingState = {
  monitorStream: null,
  audioContext: null,
  analyser: null,
  animationFrameId: null,
  mediaRecorder: null,
  chunks: [],
  recordedBlob: null,
};

export async function loadElevenLabsVoices(setStatus) {
  if (voiceStore.get().availableVoices.elevenlabs.length) return;
  try {
    const data = await api('/api/audio/voices?provider=elevenlabs');
    voiceStore.set(state => ({
      availableVoices: { ...state.availableVoices, elevenlabs: data.voices || [] }
    }));
  } catch (error) {
    if (setStatus) setStatus(`Could not load ElevenLabs voices: ${error.message}`);
  }
}

export async function loadSparkVoices(setStatus) {
  if (voiceStore.get().availableVoices.spark.length) return;
  try {
    const data = await api('/api/audio/spark/voices');
    voiceStore.set(state => ({
      availableVoices: { ...state.availableVoices, spark: data.voices || [] }
    }));
  } catch (error) {
    if (setStatus) setStatus(`Could not load cloned voices: ${error.message}`);
  }
}

export async function loadPiperVoices(setStatus) {
  if (voiceStore.get().availableVoices.piper.length) return;
  try {
    const data = await api('/api/audio/voices?provider=piper');
    voiceStore.set(state => ({
      availableVoices: { ...state.availableVoices, piper: data.voices || [] }
    }));
  } catch (error) {
    if (setStatus) setStatus(`Could not load Piper voices: ${error.message}`);
  }
}

let previewAudio = null;

export async function previewVoice(provider, voice, setStatus) {
  if (!voice?.voiceId) return;
  if (previewAudio) {
    previewAudio.pause();
    previewAudio = null;
  }
  try {
    let src;
    if (provider === 'elevenlabs') {
      src = voice.previewUrl;
      if (!src) {
        if (setStatus) setStatus('No preview available for this voice.');
        return;
      }
    } else if (provider === 'spark') {
      src = await loadProtectedAsset(`/api/audio/spark/voices/${encodeURIComponent(voice.voiceId)}/reference`);
    } else if (provider === 'piper') {
      if (setStatus) setStatus(`Synthesizing preview for "${voice.label || voice.voiceId}"...`);
      src = await loadProtectedAsset(`/api/audio/piper/voices/${encodeURIComponent(voice.voiceId)}/preview`);
    } else {
      return;
    }
    if (!src) return;
    previewAudio = new Audio(src);
    await previewAudio.play();
    if (setStatus) setStatus(`Previewing "${voice.label || voice.voiceId}".`);
  } catch (error) {
    if (setStatus) setStatus(`Preview failed: ${error.message}`);
  }
}

export async function cloneVoice(blob, name, setStatus) {
  try {
    if (setStatus) setStatus(`Cloning voice "${name}"...`);
    const form = new FormData();
    form.append('audio', blob, 'recording.webm');
    form.append('name', name);
    const data = await api('/api/audio/spark/voices', { method: 'POST', body: form });
    
    voiceStore.set(state => ({
      availableVoices: { 
        ...state.availableVoices, 
        spark: [...state.availableVoices.spark, data.voice] 
      }
    }));
    queueSync(projectStore.get().storyboards.find(s => s.id === projectStore.get().currentId), setStatus);
    
    if (setStatus) setStatus(`Voice "${name}" added to the library. Assign it to a speaker from the Voices dropdown.`);
    return true;
  } catch (error) {
    if (setStatus) setStatus(`Voice cloning failed: ${error.message}`);
    return false;
  }
}

export async function deleteVoice(voiceId, label, setStatus) {
  if (!window.confirm(`Delete the voice "${label || voiceId}"? This cannot be undone.`)) return;
  try {
    await api(`/api/audio/spark/voices/${encodeURIComponent(voiceId)}`, { method: 'DELETE' });
    
    voiceStore.set(state => {
      const sparkVoices = state.availableVoices.spark.filter((voice) => voice.voiceId !== voiceId);
      const voiceMapSpark = { ...state.voiceMap.spark };
      Object.keys(voiceMapSpark).forEach((speaker) => {
        if (voiceMapSpark[speaker]?.voiceId === voiceId) delete voiceMapSpark[speaker];
      });
      return {
        availableVoices: { ...state.availableVoices, spark: sparkVoices },
        voiceMap: { ...state.voiceMap, spark: voiceMapSpark }
      };
    });

    queueSync(projectStore.get().storyboards.find(s => s.id === projectStore.get().currentId), setStatus);
    if (setStatus) setStatus(`Voice "${label || voiceId}" deleted.`);
  } catch (error) {
    if (setStatus) setStatus(`Voice delete failed: ${error.message}`);
  }
}

export function drawWaveform(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const analyser = voiceRecordingState.analyser;
  if (!analyser) return;
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
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    x += sliceWidth;
  }
  ctx.lineTo(canvas.width, canvas.height / 2);
  ctx.stroke();
  voiceRecordingState.animationFrameId = requestAnimationFrame(() => drawWaveform(canvas));
}

export function stopMonitorStream(canvas) {
  const rec = voiceRecordingState;
  if (rec.animationFrameId) {
    cancelAnimationFrame(rec.animationFrameId);
    rec.animationFrameId = null;
  }
  if (rec.monitorStream) rec.monitorStream.getTracks().forEach((track) => track.stop());
  rec.monitorStream = null;
  if (rec.audioContext && rec.audioContext.state !== 'closed') rec.audioContext.close().catch(() => {});
  rec.audioContext = null;
  rec.analyser = null;
  if (canvas) {
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  }
}

export function attachMonitorStream(stream, els) {
  stopMonitorStream(els.voiceWaveformCanvas);
  voiceRecordingState.monitorStream = stream;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AudioContextClass();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  voiceRecordingState.audioContext = audioContext;
  voiceRecordingState.analyser = analyser;
  voiceRecordingState.animationFrameId = requestAnimationFrame(() => drawWaveform(els.voiceWaveformCanvas));
  const track = stream.getAudioTracks()[0];
  els.voiceMicStatus.textContent = `Listening on: ${track?.label || 'selected microphone'} — speak to test`;
  els.voiceRecordBtn.disabled = false;
}

export async function populateMicList(activeDeviceId, els) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mics = devices.filter((device) => device.kind === 'audioinput');
  els.voiceMicSelect.innerHTML = '';
  mics.forEach((mic, index) => {
    const option = document.createElement('option');
    option.value = mic.deviceId;
    option.textContent = mic.label || `Microphone ${index + 1}`;
    els.voiceMicSelect.appendChild(option);
  });
  if (activeDeviceId) els.voiceMicSelect.value = activeDeviceId;
}

export async function switchMicrophone(deviceId, els) {
  els.voiceMicStatus.textContent = 'Switching microphone...';
  els.voiceRecordBtn.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
    attachMonitorStream(stream, els);
  } catch (error) {
    els.voiceMicStatus.textContent = `Microphone access failed: ${error.message}`;
  }
}

export async function initMicMonitor(els) {
  els.voiceMicStatus.textContent = 'Requesting microphone access...';
  els.voiceRecordBtn.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const activeDeviceId = stream.getAudioTracks()[0]?.getSettings().deviceId || '';
    await populateMicList(activeDeviceId, els);
    attachMonitorStream(stream, els);
  } catch (error) {
    els.voiceMicStatus.textContent = `Microphone access failed: ${error.message}`;
  }
}

export function resetVoiceRecordingUI(els) {
  els.voiceRecordPreview.hidden = true;
  els.voiceRecordPreview.removeAttribute('src');
  els.voiceDurationNote.hidden = true;
  els.voiceDurationNote.textContent = '';
  els.voiceSaveBtn.disabled = true;
  els.voiceNameInput.value = '';
  voiceRecordingState.recordedBlob = null;
}

export function renderVoiceLibraryList(els, setStatus) {
  const voices = voiceStore.get().availableVoices.spark || [];
  els.voiceLibraryList.innerHTML = '';
  if (!voices.length) {
    const empty = document.createElement('div');
    empty.className = 'voice-library-empty';
    empty.textContent = 'No cloned voices yet.';
    els.voiceLibraryList.appendChild(empty);
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
    loadProtectedAsset(`/api/audio/spark/voices/${encodeURIComponent(voice.voiceId)}/reference`).then((url) => { if (url) audio.src = url; });
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'secondary text-button';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', async () => {
      await deleteVoice(voice.voiceId, voice.label, setStatus);
      renderVoiceLibraryList(els, setStatus);
    });
    row.append(label, audio, deleteBtn);
    els.voiceLibraryList.appendChild(row);
  });
}

export async function openVoiceLibraryModal(els, setStatus) {
  await loadSparkVoices(setStatus);
  renderVoiceLibraryList(els, setStatus);
  resetVoiceRecordingUI(els);
  els.voiceLibraryModal.showModal();
  await initMicMonitor(els);
}

export function closeVoiceLibraryCleanup(els) {
  const rec = voiceRecordingState;
  if (rec.mediaRecorder && rec.mediaRecorder.state !== 'inactive') rec.mediaRecorder.stop();
  rec.mediaRecorder = null;
  rec.chunks = [];
  stopMonitorStream(els.voiceWaveformCanvas);
  resetVoiceRecordingUI(els);
}

export function toggleVoiceRecording(els) {
  const rec = voiceRecordingState;
  if (rec.mediaRecorder && rec.mediaRecorder.state === 'recording') {
    rec.mediaRecorder.stop();
    return;
  }
  if (!rec.monitorStream) return;

  resetVoiceRecordingUI(els);
  rec.chunks = [];
  const mediaRecorder = new MediaRecorder(rec.monitorStream);
  rec.mediaRecorder = mediaRecorder;
  mediaRecorder.ondataavailable = (event) => { if (event.data.size) rec.chunks.push(event.data); };
  mediaRecorder.onstop = () => {
    const blob = new Blob(rec.chunks, { type: 'audio/webm' });
    rec.recordedBlob = blob;
    els.voiceRecordPreview.src = URL.createObjectURL(blob);
    els.voiceRecordPreview.hidden = false;
    els.voiceRecordPreview.addEventListener('loadedmetadata', () => {
      const seconds = els.voiceRecordPreview.duration;
      els.voiceDurationNote.hidden = false;
      els.voiceDurationNote.textContent = Number.isFinite(seconds)
        ? `Recorded ${seconds.toFixed(1)}s${seconds < 10 ? ' — for best quality, aim for 10-15s' : ''}`
        : '';
    }, { once: true });
    els.voiceSaveBtn.disabled = false;
    els.voiceRecordBtn.textContent = 'Record';
  };
  mediaRecorder.start();
  els.voiceRecordBtn.textContent = 'Stop recording';
}
