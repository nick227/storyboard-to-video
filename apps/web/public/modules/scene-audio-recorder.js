import { api } from './api.js';
import { loadProtectedAsset } from './assets.js';
import { ensureProjectSynced, getCurrentStoryboardRecord, queueSync } from './persistence.js';
import { imageShot } from './scene-shots.js';
import { projectStore, sceneStore } from './store.js';

export const sceneAudioRecordingState = {
  sceneId: null, stream: null, recorder: null, chunks: [], blob: null, blobUrl: null,
  analyser: null, audioContext: null, animationFrame: null, durationSeconds: null,
  monitorGain: null,
  gateGain: null, recordingStream: null, calibration: null, gateThreshold: null, gateOpen: true,
};

function setRecorderStatus(els, message) { if (els.sceneAudioRecordStatus) els.sceneAudioRecordStatus.textContent = message; }

function microphoneConstraints(deviceId, reduceNoise = true) {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    channelCount: { ideal: 1 },
    latency: { ideal: 0 },
    echoCancellation: false,
    noiseSuppression: reduceNoise,
    autoGainControl: false,
  };
}

function revokeRecordingUrl() {
  if (sceneAudioRecordingState.blobUrl) URL.revokeObjectURL(sceneAudioRecordingState.blobUrl);
  sceneAudioRecordingState.blobUrl = null;
}

function stopStream(els) {
  const state = sceneAudioRecordingState;
  if (state.animationFrame) cancelAnimationFrame(state.animationFrame);
  state.animationFrame = null;
  if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
  state.stream = null;
  if (state.recordingStream) state.recordingStream.getTracks().forEach((track) => track.stop());
  state.recordingStream = null;
  if (state.audioContext && state.audioContext.state !== 'closed') state.audioContext.close().catch(() => {});
  state.audioContext = null;
  state.analyser = null;
  state.monitorGain = null;
  state.gateGain = null; state.calibration = null; state.gateThreshold = null; state.gateOpen = true;
  els.sceneAudioWaveform?.getContext('2d')?.clearRect(0, 0, els.sceneAudioWaveform.width, els.sceneAudioWaveform.height);
}

function drawWaveform(els) {
  const canvas = els.sceneAudioWaveform;
  const analyser = sceneAudioRecordingState.analyser;
  if (!canvas || !analyser) return;
  const ctx = canvas.getContext('2d');
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);
  const rms = Math.sqrt(data.reduce((sum, sample) => sum + sample ** 2, 0) / data.length);
  const db = Math.max(-60, 20 * Math.log10(Math.max(rms, 0.001)));
  if (els.sceneAudioInputLevel) els.sceneAudioInputLevel.value = db;
  if (els.sceneAudioInputLevelText) {
    els.sceneAudioInputLevelText.textContent = db > -3 ? 'Clipping' : db > -24 ? 'Good' : db > -42 ? 'Low' : 'Quiet';
  }
  const state = sceneAudioRecordingState;
  if (state.calibration) {
    state.calibration.samples.push(rms);
    if (performance.now() - state.calibration.startedAt >= 2000) finishNoiseGateCalibration(els);
  } else if (state.gateGain && state.gateThreshold && els.sceneAudioNoiseGate?.checked) {
    const shouldOpen = state.gateOpen ? rms >= state.gateThreshold : rms >= state.gateThreshold * 1.25;
    if (shouldOpen !== state.gateOpen) {
      state.gateOpen = shouldOpen;
      state.gateGain.gain.setTargetAtTime(shouldOpen ? 1 : 0.08, state.audioContext.currentTime, shouldOpen ? 0.006 : 0.25);
    }
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#4f8cff'; ctx.lineWidth = 2; ctx.beginPath();
  const width = canvas.width / data.length;
  data.forEach((sample, index) => {
    const x = index * width; const y = ((sample + 1) / 2) * canvas.height;
    if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  sceneAudioRecordingState.animationFrame = requestAnimationFrame(() => drawWaveform(els));
}

async function attachStream(stream, els) {
  stopStream(els);
  const state = sceneAudioRecordingState;
  state.stream = stream;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (AudioContextClass) {
    let context;
    try { context = new AudioContextClass({ latencyHint: 'interactive' }); }
    catch (_) { context = new AudioContextClass(); }
    const analyser = context.createAnalyser(); analyser.fftSize = 2048;
    const gateGain = context.createGain(); gateGain.gain.value = 1;
    const source = context.createMediaStreamSource(stream);
    const monitorGain = context.createGain();
    const recordingDestination = context.createMediaStreamDestination();
    // A quieter sidetone reduces comb-filtering against the performer's naturally heard voice.
    monitorGain.gain.value = els.sceneAudioMonitorMic?.checked ? 0.6 : 0;
    source.connect(analyser);
    source.connect(gateGain);
    gateGain.connect(recordingDestination);
    gateGain.connect(monitorGain).connect(context.destination);
    state.audioContext = context; state.analyser = analyser;
    state.monitorGain = monitorGain;
    state.gateGain = gateGain; state.recordingStream = recordingDestination.stream;
    state.animationFrame = requestAnimationFrame(() => drawWaveform(els));
  }
  const track = stream.getAudioTracks()[0];
  const noiseSuppression = track?.getSettings?.().noiseSuppression;
  if (typeof noiseSuppression === 'boolean') els.sceneAudioReduceNoise.checked = noiseSuppression;
  resetNoiseGateCalibration(els);
  els.sceneAudioCalibrateBtn.disabled = false;
  setRecorderStatus(els, `Ready: ${track?.label || 'microphone'}`);
  els.sceneAudioRecordToggle.disabled = false;
}

async function populateMicrophones(els, activeDeviceId) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const microphones = devices.filter((device) => device.kind === 'audioinput');
  els.sceneAudioMicSelect.innerHTML = '';
  microphones.forEach((microphone, index) => {
    const option = document.createElement('option'); option.value = microphone.deviceId;
    option.textContent = microphone.label || `Microphone ${index + 1}`;
    els.sceneAudioMicSelect.appendChild(option);
  });
  if (activeDeviceId) els.sceneAudioMicSelect.value = activeDeviceId;
}

export async function switchSceneAudioMicrophone(deviceId, els) {
  const sceneId = sceneAudioRecordingState.sceneId;
  if (!sceneId) return;
  setRecorderStatus(els, 'Switching microphone…');
  els.sceneAudioRecordToggle.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints(deviceId, els.sceneAudioReduceNoise.checked) });
    if (sceneAudioRecordingState.sceneId !== sceneId) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    await attachStream(stream, els);
  } catch (error) { setRecorderStatus(els, `Microphone unavailable: ${error.message}`); }
}

function resetTake(els) {
  const state = sceneAudioRecordingState;
  revokeRecordingUrl(); state.blob = null; state.chunks = []; state.durationSeconds = null;
  if (!els.sceneAudioRecordVideo.hidden) { els.sceneAudioRecordVideo.pause(); els.sceneAudioRecordVideo.currentTime = 0; }
  els.sceneAudioRecordPreview.pause(); els.sceneAudioRecordPreview.removeAttribute('src'); els.sceneAudioRecordPreview.load();
  els.sceneAudioRecordPreview.hidden = true; els.sceneAudioPreviewBtn.hidden = true;
  els.sceneAudioPreviewBtn.textContent = 'Play';
  els.sceneAudioSubmitBtn.hidden = true; els.sceneAudioSubmitBtn.disabled = false;
  els.sceneAudioRetakeBtn.hidden = true; els.sceneAudioRecordToggle.hidden = false; els.sceneAudioRecordToggle.textContent = 'Start recording';
  els.sceneAudioMicSelect.disabled = false; els.sceneAudioReduceNoise.disabled = false;
  els.sceneAudioCalibrateBtn.disabled = !sceneAudioRecordingState.stream;
}

function visualForScene(scene) {
  const shot = imageShot(scene);
  const activeVideo = shot.videoVersions?.[shot.activeVideoVersionIndex];
  const activeImage = shot.versions?.[shot.activeVersionIndex];
  if (scene.activeVisualType === 'video' && activeVideo?.path) return { type: 'video', path: activeVideo.path };
  if (activeImage?.path) return { type: 'image', path: activeImage.path };
  if (activeVideo?.path) return { type: 'video', path: activeVideo.path };
  return null;
}

async function loadVisual(scene, els) {
  els.sceneAudioRecordImage.hidden = true; els.sceneAudioRecordVideo.hidden = true; els.sceneAudioRecordEmpty.hidden = false;
  const visual = visualForScene(scene);
  if (!visual) return;
  const url = await loadProtectedAsset(visual.path);
  if (!url || sceneAudioRecordingState.sceneId !== scene.id) return;
  els.sceneAudioRecordEmpty.hidden = true;
  if (visual.type === 'video') {
    els.sceneAudioRecordVideo.src = url; els.sceneAudioRecordVideo.muted = true; els.sceneAudioRecordVideo.hidden = false;
  } else {
    els.sceneAudioRecordImage.src = url; els.sceneAudioRecordImage.hidden = false;
  }
}

export async function openSceneAudioRecorder(scene, els) {
  closeSceneAudioRecorder(els);
  sceneAudioRecordingState.sceneId = scene.id;
  els.sceneAudioRecorder.hidden = false; resetTake(els);
  els.sceneAudioMonitorMic.checked = false;
  els.sceneAudioInputLevel.value = -60; els.sceneAudioInputLevelText.textContent = 'Quiet';
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    setRecorderStatus(els, 'Audio recording is not supported by this browser.');
    return;
  }
  setRecorderStatus(els, 'Requesting microphone access…');
  await loadVisual(scene, els).catch((error) => setRecorderStatus(els, `Visual preview unavailable: ${error.message}`));
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints(null, els.sceneAudioReduceNoise.checked) });
    if (sceneAudioRecordingState.sceneId !== scene.id) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const deviceId = stream.getAudioTracks()[0]?.getSettings().deviceId || '';
    await populateMicrophones(els, deviceId); await attachStream(stream, els);
  } catch (error) { setRecorderStatus(els, `Microphone unavailable: ${error.message}`); }
}

export function closeSceneAudioRecorder(els) {
  const state = sceneAudioRecordingState;
  if (state.recorder && state.recorder.state !== 'inactive') { state.recorder.onstop = null; state.recorder.stop(); }
  state.recorder = null; stopStream(els); revokeRecordingUrl();
  state.sceneId = null; state.blob = null; state.chunks = []; state.durationSeconds = null;
  if (!els?.sceneAudioRecorder) return;
  els.sceneAudioRecorder.hidden = true;
  els.sceneAudioMonitorMic.checked = false;
  els.sceneAudioRecordVideo.pause(); els.sceneAudioRecordVideo.removeAttribute('src'); els.sceneAudioRecordVideo.load();
  els.sceneAudioRecordImage.removeAttribute('src');
  els.sceneAudioRecordPreview.pause(); els.sceneAudioRecordPreview.removeAttribute('src'); els.sceneAudioRecordPreview.load();
}

function preferredRecorderOptions() {
  const candidates = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];
  const mimeType = candidates.find((type) => MediaRecorder.isTypeSupported?.(type));
  return mimeType ? { mimeType } : undefined;
}

export async function toggleSceneAudioRecording(els) {
  const state = sceneAudioRecordingState;
  if (state.recorder?.state === 'recording') { state.recorder.stop(); return; }
  if (!state.stream || !window.MediaRecorder) return;
  if (state.audioContext?.state === 'suspended') await state.audioContext.resume();
  resetTake(els); state.chunks = [];
  let recorder;
  try { recorder = new MediaRecorder(state.recordingStream || state.stream, preferredRecorderOptions()); }
  catch (error) { setRecorderStatus(els, `Recording could not start: ${error.message}`); return; }
  state.recorder = recorder;
  recorder.ondataavailable = (event) => { if (event.data.size) state.chunks.push(event.data); };
  recorder.onstop = () => {
    const mimeType = recorder.mimeType || state.chunks[0]?.type || 'audio/webm';
    state.blob = new Blob(state.chunks, { type: mimeType }); state.blobUrl = URL.createObjectURL(state.blob);
    els.sceneAudioRecordPreview.src = state.blobUrl;
    els.sceneAudioRecordPreview.addEventListener('loadedmetadata', () => {
      state.durationSeconds = Number.isFinite(els.sceneAudioRecordPreview.duration) ? els.sceneAudioRecordPreview.duration : null;
      setRecorderStatus(els, state.durationSeconds ? `Recorded ${state.durationSeconds.toFixed(1)} seconds. Preview it with the visual before using it.` : 'Recording ready to preview.');
    }, { once: true });
    els.sceneAudioPreviewBtn.hidden = false; els.sceneAudioSubmitBtn.hidden = false;
    els.sceneAudioRetakeBtn.hidden = false; els.sceneAudioRecordToggle.hidden = true;
    els.sceneAudioMicSelect.disabled = false; els.sceneAudioReduceNoise.disabled = false;
    els.sceneAudioCalibrateBtn.disabled = false;
  };
  recorder.start(); els.sceneAudioRecordToggle.textContent = 'Stop recording';
  els.sceneAudioMicSelect.disabled = true; els.sceneAudioReduceNoise.disabled = true;
  els.sceneAudioCalibrateBtn.disabled = true;
  setRecorderStatus(els, 'Recording…');
}

export function retakeSceneAudioRecording(els) { resetTake(els); setRecorderStatus(els, 'Ready for another take.'); }

export function setSceneAudioMonitoring(enabled) {
  const { audioContext, monitorGain } = sceneAudioRecordingState;
  if (enabled && audioContext?.state === 'suspended') audioContext.resume().catch(() => {});
  if (monitorGain && audioContext) {
    monitorGain.gain.cancelScheduledValues(audioContext.currentTime);
    monitorGain.gain.setTargetAtTime(enabled ? 0.6 : 0, audioContext.currentTime, 0.01);
  }
}

export async function setSceneAudioNoiseSuppression(enabled, els) {
  const track = sceneAudioRecordingState.stream?.getAudioTracks?.()[0];
  if (!track?.applyConstraints) return;
  try {
    await track.applyConstraints({ noiseSuppression: enabled, echoCancellation: false, autoGainControl: false });
    const applied = track.getSettings?.().noiseSuppression;
    setRecorderStatus(els, applied === undefined
      ? `Background noise reduction ${enabled ? 'requested' : 'disabled'}.`
      : `Background noise reduction ${applied ? 'on' : 'off'}.`);
    resetNoiseGateCalibration(els);
  } catch (error) {
    els.sceneAudioReduceNoise.checked = !enabled;
    setRecorderStatus(els, `This microphone cannot change noise reduction: ${error.message}`);
  }
}

function resetNoiseGateCalibration(els) {
  const state = sceneAudioRecordingState;
  state.calibration = null; state.gateThreshold = null; state.gateOpen = true;
  if (state.gateGain && state.audioContext) state.gateGain.gain.setValueAtTime(1, state.audioContext.currentTime);
  if (els?.sceneAudioNoiseGate) els.sceneAudioNoiseGate.disabled = true;
  if (els?.sceneAudioGateStatus) els.sceneAudioGateStatus.textContent = 'Calibrate while staying quiet.';
}

function finishNoiseGateCalibration(els) {
  const state = sceneAudioRecordingState;
  const samples = state.calibration?.samples || [];
  state.calibration = null;
  if (!samples.length) return;
  const ordered = [...samples].sort((a, b) => a - b);
  const noiseFloor = ordered[Math.floor((ordered.length - 1) * 0.8)];
  state.gateThreshold = Math.min(0.035, Math.max(0.006, noiseFloor * 1.6));
  state.gateOpen = true;
  els.sceneAudioNoiseGate.disabled = false;
  els.sceneAudioCalibrateBtn.disabled = false;
  const floorDb = Math.round(20 * Math.log10(Math.max(noiseFloor, 0.001)));
  els.sceneAudioGateStatus.textContent = `Calibrated at ${floorDb} dB. The gate only reduces sound between phrases.`;
}

export function calibrateSceneAudioNoiseGate(els) {
  const state = sceneAudioRecordingState;
  if (!state.analyser || state.recorder?.state === 'recording') return;
  state.gateThreshold = null; state.gateOpen = true;
  if (state.gateGain && state.audioContext) state.gateGain.gain.setValueAtTime(1, state.audioContext.currentTime);
  state.calibration = { startedAt: performance.now(), samples: [] };
  els.sceneAudioCalibrateBtn.disabled = true;
  els.sceneAudioNoiseGate.disabled = true;
  els.sceneAudioGateStatus.textContent = 'Stay quiet for 2 seconds…';
}

export function setSceneAudioNoiseGate(enabled) {
  const state = sceneAudioRecordingState;
  if (!state.gateGain || !state.audioContext) return;
  state.gateOpen = true;
  state.gateGain.gain.setTargetAtTime(1, state.audioContext.currentTime, 0.01);
  if (!enabled) state.calibration = null;
}

export async function previewSceneAudioRecording(els) {
  if (!sceneAudioRecordingState.blob) return;
  const audio = els.sceneAudioRecordPreview; const video = els.sceneAudioRecordVideo;
  if (!audio.paused) {
    audio.pause();
    if (!video.hidden) video.pause();
    els.sceneAudioPreviewBtn.textContent = 'Play';
    return;
  }
  audio.currentTime = 0;
  if (!video.hidden) { video.pause(); video.currentTime = 0; video.muted = true; await video.play().catch(() => {}); }
  audio.onended = () => { if (!video.hidden) video.pause(); els.sceneAudioPreviewBtn.textContent = 'Play'; };
  els.sceneAudioPreviewBtn.textContent = 'Stop';
  try { await audio.play(); }
  catch (error) {
    if (!video.hidden) video.pause();
    els.sceneAudioPreviewBtn.textContent = 'Play';
    throw error;
  }
}

async function sha256(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function submitSceneAudioRecording(scene, index, els, setStatus) {
  const state = sceneAudioRecordingState;
  if (!state.blob || state.sceneId !== scene.id) return null;
  await ensureProjectSynced();
  const form = new FormData();
  const extension = state.blob.type.includes('ogg') ? 'ogg' : state.blob.type.includes('mp4') ? 'm4a' : 'webm';
  form.append('audio', state.blob, `scene-recording.${extension}`);
  form.append('projectId', projectStore.get().currentId); form.append('sceneId', scene.id);
  form.append('sceneNumber', String(index + 1)); form.append('sceneTitle', String(scene.title || `Scene ${index + 1}`));
  form.append('narrationText', String(scene.narrationText || ''));
  if (state.durationSeconds) form.append('durationSeconds', String(state.durationSeconds));
  const digest = await sha256(state.blob);
  const idempotencyKey = `recording:${scene.audioVersions?.length || 0}:${digest}`;
  els.sceneAudioRecorder.setAttribute('aria-busy', 'true'); els.sceneAudioSubmitBtn.disabled = true;
  setRecorderStatus(els, 'Uploading recording…'); if (setStatus) setStatus(`Uploading recording for scene ${index + 1}…`);
  try {
    const data = await api('/api/audio/recordings', { method: 'POST', idempotencyKey, body: form });
    const scenes = sceneStore.get().scenes.map((item) => item.id === scene.id ? data.scene : item);
    sceneStore.set({ scenes });
    const record = getCurrentStoryboardRecord();
    if (record) { record.scenes = scenes; record.revision = data.revision; queueSync(record, setStatus); }
    if (setStatus) setStatus(`Recording added to scene ${index + 1}.`);
    closeSceneAudioRecorder(els);
    return data;
  } catch (error) {
    setRecorderStatus(els, `Upload failed: ${error.message}`); els.sceneAudioSubmitBtn.disabled = false; throw error;
  } finally { els.sceneAudioRecorder.removeAttribute('aria-busy'); }
}
