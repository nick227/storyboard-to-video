const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const archiver = require('archiver');
const multer = require('multer');
const text2wav = require('text2wav');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const STYLE_DIR = path.join(ROOT, 'styles');
const STYLE_REF_DIR = path.join(ROOT, 'style-references');
const GENERATED_DIR = path.join(ROOT, 'data', 'generated');
const AUDIO_DIR = path.join(ROOT, 'data', 'audio');
const VIDEO_DIR = path.join(ROOT, 'data', 'videos');
const VIDEO_STUB_DIR = path.join(ROOT, 'data', 'stubs');
const LTX_SHARED_DIR = path.resolve(process.env.LTX_SHARED_DIR || '/home/administrator/web/ltx-env/io/basic-cartoon-poc');
const ZIP_DIR = path.join(ROOT, 'data', 'zips');
const MAX_STYLE_REFERENCE_IMAGES = 8;
const MAX_REFERENCE_FILE_SIZE = 8 * 1024 * 1024;
const MAX_SCRIPT_LENGTH = 200_000;
const MAX_PROMPT_LENGTH = 20_000;
const MAX_LINE_TEXT_LENGTH = 2_000;
const TEXT_PROVIDERS = new Set(['gemini', 'openai']);
const IMAGE_PROVIDERS = new Set(['gemini', 'openai', 'dezgo', 'stub']);
const AUDIO_PROVIDERS = new Set(['elevenlabs', 'piper', 'stub']);
const PIPER_DIR = path.join(ROOT, 'vendor', 'piper');
const PIPER_BINARY_PATH = process.env.PIPER_BINARY_PATH || path.join(PIPER_DIR, 'piper');
const PIPER_VOICES_DIR = path.join(PIPER_DIR, 'voices');
const PIPER_VOICE_IDS = String(process.env.PIPER_VOICE_IDS || 'en_US-lessac-medium,en_US-amy-medium,en_US-ryan-medium')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);
const VIDEO_PROVIDER = process.env.VIDEO_PROVIDER === 'stub' ? 'stub' : 'ltx';
const LTX_VIDEO_URL = String(process.env.LTX_VIDEO_URL || 'http://localhost:8000').replace(/\/+$/, '');
const AUDIO_SAMPLE_RATE = 24_000;
const AUDIO_CHANNELS = 1;
const AUDIO_BITS_PER_SAMPLE = 16;
const AUDIO_LINE_GAP_MS = 250;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/generated', express.static(GENERATED_DIR));
app.use('/audio', express.static(AUDIO_DIR));
app.use('/videos', express.static(VIDEO_DIR));
app.use('/style-references', express.static(STYLE_REF_DIR));

function slugify(input = '') {
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sanitizeStyleId(styleId = '') {
  return slugify(styleId);
}

function normalizeRefType(type = '') {
  return type === 'world' ? 'world' : 'characters';
}

function getStyleReferenceDir(styleId, type) {
  return path.join(STYLE_REF_DIR, sanitizeStyleId(styleId), normalizeRefType(type));
}

function toPublicStyleRefPath(styleId, type, fileName) {
  return `/style-references/${sanitizeStyleId(styleId)}/${normalizeRefType(type)}/${encodeURIComponent(fileName)}`;
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

function listReferenceFiles(styleId, type) {
  const dir = getStyleReferenceDir(styleId, type);
  ensureDir(dir);
  return fs.readdirSync(dir)
    .filter((file) => /\.(png|jpe?g|webp|gif)$/i.test(file))
    .sort()
    .map((fileName) => ({
      fileName,
      path: path.join(dir, fileName),
      url: toPublicStyleRefPath(styleId, type, fileName),
      type: normalizeRefType(type),
    }));
}

function listStyleReferences(styleId) {
  return {
    characters: listReferenceFiles(styleId, 'characters').map(({ fileName, url, type }) => ({ fileName, url, type })),
    world: listReferenceFiles(styleId, 'world').map(({ fileName, url, type }) => ({ fileName, url, type })),
  };
}

function getStyleReferencePaths(styleId) {
  const characters = listReferenceFiles(styleId, 'characters').slice(0, 4);
  const world = listReferenceFiles(styleId, 'world').slice(0, 4);
  return [...characters, ...world].slice(0, MAX_STYLE_REFERENCE_IMAGES).map((x) => x.path);
}

function listStyles() {
  return fs.readdirSync(STYLE_DIR)
    .filter((file) => file.endsWith('.md'))
    .map((file) => {
      const fullPath = path.join(STYLE_DIR, file);
      const content = fs.readFileSync(fullPath, 'utf8').trim();
      const firstLine = content.split('\n')[0].replace(/^#\s*/, '').trim();
      const id = file.replace(/\.md$/, '');
      return {
        id,
        name: firstLine || id,
        promptText: content.replace(/^#.+\n?/, '').trim(),
        file,
        references: listStyleReferences(id),
      };
    });
}

function findStyleById(id) {
  return listStyles().find((style) => style.id === id) || null;
}

function clampSceneCount(value) {
  const count = Number.parseInt(value, 10);
  return Number.isFinite(count) ? Math.min(50, Math.max(1, count)) : 6;
}

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function getAdditionalCommonPrompt(stylePrompt, commonPrompt) {
  const styleText = cleanText(stylePrompt, MAX_PROMPT_LENGTH);
  const commonText = cleanText(commonPrompt, MAX_PROMPT_LENGTH);
  if (!styleText || !commonText) return commonText;
  if (commonText === styleText) return '';
  return commonText.startsWith(styleText) ? commonText.slice(styleText.length).trim() : commonText;
}

function providerTimeout(ms) {
  return AbortSignal.timeout(Number(ms) || 120_000);
}

function videoTimeout(ms, fallback) {
  return AbortSignal.timeout(Number(ms) || fallback);
}

function videoIntegerSetting(name, fallback, min, max) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function videoDimensionSetting(name, fallback) {
  const value = videoIntegerSetting(name, fallback, 64, 2048);
  return value % 32 === 0 ? value : fallback;
}

function videoFrameSetting() {
  const value = videoIntegerSetting('VIDEO_FRAMES', 33, 1, 297);
  return (value - 1) % 8 === 0 ? value : 33;
}

function ltxUrl(pathName) {
  const normalized = String(pathName || '').startsWith('/') ? pathName : `/${pathName}`;
  return `${LTX_VIDEO_URL}${normalized}`;
}

async function verifyVideoProvider() {
  if (VIDEO_PROVIDER === 'stub') return { ok: true, provider: 'stub' };
  try {
    const response = await fetch(ltxUrl(process.env.LTX_VIDEO_HEALTH_PATH || '/ready'), {
      signal: videoTimeout(process.env.VIDEO_PREFLIGHT_TIMEOUT_MS, 3_000),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const detail = body?.error?.message || `readiness check returned HTTP ${response.status}`;
      const error = new Error(detail);
      error.code = body?.error?.code || 'NOT_READY';
      error.retryable = body?.error?.retryable !== false;
      throw error;
    }
    return { ok: true, provider: 'ltx' };
  } catch (error) {
    const wrapped = new Error(`LTX-Video daemon is unavailable at ${LTX_VIDEO_URL}: ${error.message}`);
    wrapped.statusCode = 503;
    wrapped.code = error.code || 'NOT_READY';
    wrapped.retryable = error.retryable !== false;
    throw wrapped;
  }
}

function createProviderError(provider, status, detail = '', retryAfter = '') {
  const providerName = provider.charAt(0).toUpperCase() + provider.slice(1);
  let message;
  if (status === 429) {
    message = `${providerName} API quota exceeded. Enable billing or request more quota for the configured API key, or select another provider.`;
  } else if (status === 401 || status === 403) {
    message = `${providerName} rejected the configured API key. Check the key, project access, and billing settings.`;
  } else {
    const cleanDetail = cleanText(detail, 500);
    message = `${providerName} provider error (${status})${cleanDetail ? `: ${cleanDetail}` : ''}`;
  }

  const error = new Error(message);
  error.statusCode = status === 429 ? 429 : 502;
  error.retryAfter = retryAfter;
  return error;
}

async function throwProviderResponseError(provider, response) {
  const raw = await response.text();
  let detail = raw;
  try {
    const parsed = JSON.parse(raw);
    detail = parsed?.error?.message || parsed?.message || raw;
  } catch (_) {}
  throw createProviderError(provider, response.status, detail, response.headers.get('retry-after') || '');
}


function escapeXml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function createStubImage(finalPrompt, sceneTitle = 'Storyboard scene') {
  const clean = String(finalPrompt || '').replace(/\s+/g, ' ').trim();
  const lines = [];
  for (let i = 0; i < clean.length && lines.length < 8; i += 54) lines.push(clean.slice(i, i + 54));
  const text = lines.map((line, index) => `<text x="70" y="${610 + index * 38}" font-family="Arial, sans-serif" font-size="24" fill="#222">${escapeXml(line)}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
    <rect width="1024" height="1024" fill="#fffdf5"/>
    <rect x="36" y="36" width="952" height="952" rx="24" fill="none" stroke="#111" stroke-width="8"/>
    <text x="70" y="100" font-family="Arial, sans-serif" font-size="28" font-weight="700" fill="#111">STUB PREVIEW — ${escapeXml(sceneTitle)}</text>
    <circle cx="360" cy="290" r="82" fill="#ffd85e" stroke="#111" stroke-width="10"/>
    <circle cx="335" cy="275" r="8" fill="#111"/><circle cx="385" cy="275" r="8" fill="#111"/>
    <path d="M330 320 Q360 345 390 320" fill="none" stroke="#111" stroke-width="8" stroke-linecap="round"/>
    <path d="M360 372 L360 520 M275 425 L445 425 M360 520 L300 585 M360 520 L420 585" fill="none" stroke="#111" stroke-width="12" stroke-linecap="round"/>
    <rect x="560" y="215" width="300" height="245" fill="#dce9ff" stroke="#111" stroke-width="9"/>
    <line x1="610" y1="460" x2="585" y2="565" stroke="#111" stroke-width="10"/><line x1="810" y1="460" x2="835" y2="565" stroke="#111" stroke-width="10"/>
    ${text}
  </svg>`;
  return Buffer.from(svg);
}

function extractJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {}
  const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (_) {
    return null;
  }
}

function splitIntoScenes(scriptText, sceneCount) {
  const count = clampSceneCount(sceneCount);
  const sourceText = cleanText(scriptText, MAX_SCRIPT_LENGTH);
  let chunks = sourceText
    .split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z])/) 
    .map((x) => x.trim())
    .filter(Boolean);
  if (chunks.length === 0) chunks.push('A simple opening scene introducing the story.');

  if (chunks.length < count) {
    const words = sourceText.split(/\s+/).filter(Boolean);
    if (words.length >= count) {
      chunks = Array.from({ length: count }, (_, index) => {
        const start = Math.floor((index * words.length) / count);
        const end = Math.floor(((index + 1) * words.length) / count);
        return words.slice(start, end).join(' ');
      });
    }
  }

  const out = [];
  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * chunks.length) / count);
    const end = Math.max(start + 1, Math.floor(((i + 1) * chunks.length) / count));
    const source = chunks.slice(start, end).join(' ') || chunks[i % chunks.length];
    out.push({
      sceneNumber: i + 1,
      title: `Scene ${i + 1}`,
      beat: source,
      prompt: `Show ${source}. Keep the shot clear and storyboard-friendly with one main action and readable composition.`,
    });
  }
  return out;
}

function buildGeminiParts(textPrompt, referencePaths = []) {
  const parts = [{ text: textPrompt }];
  referencePaths.forEach((refPath, index) => {
    if (!fs.existsSync(refPath)) return;
    parts.push({ text: `Reference image ${index + 1}` });
    parts.push({
      inline_data: {
        mime_type: getMimeType(refPath),
        data: fs.readFileSync(refPath).toString('base64'),
      },
    });
  });
  return parts;
}

async function callOpenAIText(userPrompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY missing');

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini',
      input: userPrompt,
    }),
    signal: providerTimeout(process.env.TEXT_PROVIDER_TIMEOUT_MS || 60_000),
  });

  if (!res.ok) {
    await throwProviderResponseError('openai', res);
  }

  const data = await res.json();
  return data.output_text || '';
}

async function callGeminiText(userPrompt, referencePaths = []) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing');

  const model = process.env.GEMINI_TEXT_MODEL || 'gemini-3.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: buildGeminiParts(userPrompt, referencePaths) }],
      generationConfig: {
        temperature: 0.7,
        responseMimeType: 'application/json',
      },
    }),
    signal: providerTimeout(process.env.TEXT_PROVIDER_TIMEOUT_MS || 60_000),
  });

  if (!res.ok) {
    await throwProviderResponseError('gemini', res);
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('\n') || '';
}

async function callOpenAIImage(finalPrompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY missing');

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
      prompt: finalPrompt,
      size: '1024x1024',
    }),
    signal: providerTimeout(process.env.IMAGE_PROVIDER_TIMEOUT_MS || 180_000),
  });

  if (!res.ok) {
    await throwProviderResponseError('openai', res);
  }

  const data = await res.json();
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI image error: no image returned');
  return { buffer: Buffer.from(b64, 'base64'), mimeType: 'image/png', extension: 'png' };
}

async function callDezgoImage(finalPrompt) {
  const apiKey = process.env.DEZGO_API_KEY;
  if (!apiKey) throw new Error('DEZGO_API_KEY missing');

  const body = new URLSearchParams({
    prompt: finalPrompt,
    width: '1024',
    height: '1024',
    guidance: process.env.DEZGO_GUIDANCE || '7',
    steps: process.env.DEZGO_STEPS || '25',
    sampler: process.env.DEZGO_SAMPLER || 'euler_a',
    negative_prompt: 'blurry, unreadable, overly detailed, deformed',
  });

  const res = await fetch('https://api.dezgo.com/text2image', {
    method: 'POST',
    headers: {
      'X-Dezgo-Key': apiKey,
      Accept: 'image/png',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: providerTimeout(process.env.IMAGE_PROVIDER_TIMEOUT_MS || 180_000),
  });

  if (!res.ok) {
    await throwProviderResponseError('dezgo', res);
  }

  const arrayBuffer = await res.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), mimeType: 'image/png', extension: 'png' };
}

async function callGeminiImage(finalPrompt, referencePaths = []) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing');

  const model = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: buildGeminiParts(finalPrompt, referencePaths) }],
      generationConfig: {
        temperature: 0.7,
        responseModalities: ['TEXT', 'IMAGE'],
      },
    }),
    signal: providerTimeout(process.env.IMAGE_PROVIDER_TIMEOUT_MS || 180_000),
  });

  if (!res.ok) {
    await throwProviderResponseError('gemini', res);
  }

  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((part) => part.inlineData?.data || part.inline_data?.data);
  const b64 = imagePart?.inlineData?.data || imagePart?.inline_data?.data;
  if (!b64) {
    const text = parts.map((part) => part.text || '').join('\n').trim();
    throw new Error(`Gemini image error: no image returned${text ? ` (${text})` : ''}`);
  }
  const mimeType = imagePart?.inlineData?.mimeType || imagePart?.inline_data?.mime_type || 'image/png';
  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png';
  return { buffer: Buffer.from(b64, 'base64'), mimeType, extension };
}

async function buildScenePrompts({ scriptText, sceneCount, style, commonPromptText, provider }) {
  const styleText = style.promptText || '';
  const additionalPromptText = getAdditionalCommonPrompt(styleText, commonPromptText);
  const referencePaths = getStyleReferencePaths(style.id);
  const fallback = splitIntoScenes(scriptText, sceneCount).map((scene) => ({
    ...scene,
    prompt: `${scene.prompt} ${additionalPromptText ? additionalPromptText + ' ' : ''}Style direction: ${styleText}`.trim(),
  }));

  if (provider === 'stub') {
    return { scenes: fallback, usedFallback: true, warning: 'Stub text mode selected; local fallback prompts were used.' };
  }

  const prompt = `You are generating storyboard scene prompts for image generation.
Return strict JSON only in this shape:
{"scenes":[{"sceneNumber":1,"title":"...","beat":"...","prompt":"clean image prompt..."}]}

Rules:
- Create exactly ${sceneCount} scenes.
- Each prompt must describe who/what is on screen, setting, action, framing, and mood.
- Keep prompts concise, clean, and directly usable for image generation.
- Ensure each scene is visually distinct and readable in a storyboard grid.
- Apply this style direction to every prompt: ${styleText}
- Also blend in this additional common prompt text: ${additionalPromptText || 'none'}
- ${provider === 'gemini' && referencePaths.length ? 'Reference images are attached; use them as consistency guides for recurring characters and world design.' : 'No reference images are attached to this provider request.'}
- Story text:
${scriptText}`;

  try {
    let raw;
    if (provider === 'openai') raw = await callOpenAIText(prompt);
    else raw = await callGeminiText(prompt, referencePaths);

    const parsed = extractJson(raw);
    if (!parsed?.scenes || !Array.isArray(parsed.scenes)) {
      return { scenes: fallback, usedFallback: true, warning: 'The provider returned invalid scene data; local fallback prompts were used.' };
    }

    const scenes = fallback.map((fallbackScene, index) => {
      const scene = parsed.scenes[index] || {};
      return {
        sceneNumber: index + 1,
        title: cleanText(scene.title, 200) || fallbackScene.title,
        beat: cleanText(scene.beat, 5_000) || fallbackScene.beat,
        prompt: cleanText(scene.prompt, MAX_PROMPT_LENGTH) || fallbackScene.prompt,
      };
    });
    const usedFallback = parsed.scenes.length !== sceneCount;
    return {
      scenes,
      usedFallback,
      warning: usedFallback ? `The provider returned ${parsed.scenes.length} of ${sceneCount} scenes; local fallback filled the remainder.` : '',
    };
  } catch (error) {
    return {
      scenes: fallback,
      usedFallback: true,
      warning: `Provider unavailable; local fallback prompts were used. ${cleanText(error.message, 300)}`,
    };
  }
}

async function regenerateSinglePrompt({ scriptText, scene, sceneIndex, style, commonPromptText, provider, extraPromptText }) {
  const styleText = style.promptText || '';
  const additionalPromptText = getAdditionalCommonPrompt(styleText, commonPromptText);
  const referencePaths = getStyleReferencePaths(style.id);
  const fallback = `${scene.prompt || ''} ${extraPromptText || ''}`.trim();
  if (provider === 'stub') {
    return { prompt: fallback, usedFallback: true, warning: 'Stub text mode selected; the existing prompt was retained.' };
  }
  const prompt = `Return strict JSON only in this shape: {"prompt":"..."}.
Rewrite one storyboard image prompt for scene ${sceneIndex + 1}.
Story text: ${scriptText}
Scene title: ${scene.title || ''}
Scene beat: ${scene.beat || ''}
Existing prompt: ${scene.prompt || ''}
Extra user note: ${extraPromptText || 'none'}
Additional common prompt: ${additionalPromptText || 'none'}
Style direction: ${styleText}
${provider === 'gemini' && referencePaths.length ? 'Reference images are attached; use them as recurring character/world guides.' : 'No reference images are attached to this provider request.'}
Make the new prompt clean, concise, visually specific, and storyboard-friendly.`;

  try {
    let raw;
    if (provider === 'openai') raw = await callOpenAIText(prompt);
    else raw = await callGeminiText(prompt, referencePaths);

    const parsed = extractJson(raw);
    const generatedPrompt = cleanText(parsed?.prompt, MAX_PROMPT_LENGTH);
    if (!generatedPrompt) {
      return { prompt: fallback, usedFallback: true, warning: 'The provider returned invalid prompt data; the existing prompt was retained.' };
    }
    return { prompt: generatedPrompt, usedFallback: false, warning: '' };
  } catch (error) {
    return {
      prompt: fallback,
      usedFallback: true,
      warning: `Provider unavailable; the existing prompt was retained. ${cleanText(error.message, 300)}`,
    };
  }
}

async function generateImageBuffer({ provider, finalPrompt, referencePaths, sceneTitle }) {
  if (provider === 'stub') {
    return { buffer: createStubImage(finalPrompt, sceneTitle), mimeType: 'image/svg+xml', extension: 'svg' };
  }
  if (provider === 'openai') return callOpenAIImage(finalPrompt);
  if (provider === 'dezgo') return callDezgoImage(finalPrompt);
  return callGeminiImage(finalPrompt, referencePaths);
}

function buildWavBuffer(pcmBuffer, {
  sampleRate = AUDIO_SAMPLE_RATE,
  channels = AUDIO_CHANNELS,
  bitsPerSample = AUDIO_BITS_PER_SAMPLE,
} = {}) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcmBuffer.length, 40);
  return Buffer.concat([header, pcmBuffer]);
}

function createSilenceBuffer(ms, sampleRate = AUDIO_SAMPLE_RATE, channels = AUDIO_CHANNELS, bitsPerSample = AUDIO_BITS_PER_SAMPLE) {
  const bytesPerSample = bitsPerSample / 8;
  const samples = Math.round((ms / 1000) * sampleRate);
  return Buffer.alloc(samples * bytesPerSample * channels);
}

function concatenatePcmLines(pcmBuffers, {
  gapMs = AUDIO_LINE_GAP_MS,
  sampleRate = AUDIO_SAMPLE_RATE,
  channels = AUDIO_CHANNELS,
  bitsPerSample = AUDIO_BITS_PER_SAMPLE,
} = {}) {
  const gap = createSilenceBuffer(gapMs, sampleRate, channels, bitsPerSample);
  const parts = [];
  pcmBuffers.forEach((buffer, index) => {
    parts.push(buffer);
    if (index < pcmBuffers.length - 1) parts.push(gap);
  });
  return Buffer.concat(parts);
}

function parseWavPcm(buffer) {
  const wav = Buffer.from(buffer);
  let offset = 12;
  let fmt = null;
  let pcm = null;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkId === 'fmt ') {
      fmt = {
        channels: wav.readUInt16LE(chunkStart + 2),
        sampleRate: wav.readUInt32LE(chunkStart + 4),
        bitsPerSample: wav.readUInt16LE(chunkStart + 14),
      };
    } else if (chunkId === 'data') {
      pcm = wav.subarray(chunkStart, chunkStart + chunkSize);
    }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }
  if (!fmt || !pcm) throw new Error('Unrecognized WAV data from local voice engine');
  return { pcm, ...fmt };
}

const LOCAL_VOICE_VARIANTS = ['en', 'en+f3', 'en+m3', 'en+f4', 'en+m4', 'en+f2'];

function pickLocalVoice(speaker) {
  if (!speaker || speaker === 'Narrator') return 'en';
  let hash = 0;
  for (let i = 0; i < speaker.length; i++) hash = (hash * 31 + speaker.charCodeAt(i)) >>> 0;
  return LOCAL_VOICE_VARIANTS[hash % LOCAL_VOICE_VARIANTS.length];
}

async function synthesizeLocalVoiceLine(text, speaker) {
  const wav = await text2wav(text, { voice: pickLocalVoice(speaker) });
  return parseWavPcm(wav);
}

async function synthesizeStubAudioScene(lines) {
  const parsedLines = [];
  for (const line of lines) parsedLines.push(await synthesizeLocalVoiceLine(line.text, line.speaker));
  const { sampleRate, channels, bitsPerSample } = parsedLines[0];
  const combined = concatenatePcmLines(parsedLines.map((line) => line.pcm), { sampleRate, channels, bitsPerSample });
  return { buffer: buildWavBuffer(combined, { sampleRate, channels, bitsPerSample }), mimeType: 'audio/wav', extension: 'wav' };
}

function pickPiperVoiceId(speaker) {
  if (PIPER_VOICE_IDS.length === 1) return PIPER_VOICE_IDS[0];
  if (!speaker || speaker === 'Narrator') return PIPER_VOICE_IDS[0];
  let hash = 0;
  for (let i = 0; i < speaker.length; i++) hash = (hash * 31 + speaker.charCodeAt(i)) >>> 0;
  return PIPER_VOICE_IDS[hash % PIPER_VOICE_IDS.length];
}

function callPiperTts(text, voiceId) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(PIPER_BINARY_PATH)) {
      return reject(new Error(`Piper engine not installed. Run "npm run setup:piper" (expected binary at ${PIPER_BINARY_PATH}).`));
    }
    const modelPath = path.join(PIPER_VOICES_DIR, `${voiceId}.onnx`);
    if (!fs.existsSync(modelPath)) {
      return reject(new Error(`Piper voice "${voiceId}" not installed. Run "npm run setup:piper" (expected model at ${modelPath}).`));
    }

    const child = spawn(PIPER_BINARY_PATH, ['--model', modelPath, '--output_file', '-']);
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`Piper exited with code ${code}: ${cleanText(Buffer.concat(stderrChunks).toString('utf8'), 300)}`));
      }
      resolve(Buffer.concat(stdoutChunks));
    });
    child.stdin.write(text);
    child.stdin.end();
  });
}

async function synthesizePiperScene(lines) {
  const parsedLines = [];
  for (const line of lines) {
    const wav = await callPiperTts(line.text, pickPiperVoiceId(line.speaker));
    parsedLines.push(parseWavPcm(wav));
  }
  const { sampleRate, channels, bitsPerSample } = parsedLines[0];
  const combined = concatenatePcmLines(parsedLines.map((line) => line.pcm), { sampleRate, channels, bitsPerSample });
  return { buffer: buildWavBuffer(combined, { sampleRate, channels, bitsPerSample }), mimeType: 'audio/wav', extension: 'wav' };
}

async function callElevenLabsTtsPcm(text, voiceId) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY missing');

  const modelId = process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5';
  const outputFormat = process.env.ELEVENLABS_OUTPUT_FORMAT || `pcm_${AUDIO_SAMPLE_RATE}`;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': apiKey,
    },
    body: JSON.stringify({ text, model_id: modelId }),
    signal: providerTimeout(process.env.AUDIO_PROVIDER_TIMEOUT_MS || 60_000),
  });

  if (!res.ok) {
    await throwProviderResponseError('elevenlabs', res);
  }

  return Buffer.from(await res.arrayBuffer());
}

async function synthesizeElevenLabsScene(lines, voiceMap = {}) {
  const pcmBuffers = [];
  for (const line of lines) {
    const mapping = voiceMap?.[line.speaker] || voiceMap?.Narrator;
    if (!mapping?.voiceId) throw new Error(`No ElevenLabs voice mapped for speaker "${line.speaker}"`);
    pcmBuffers.push(await callElevenLabsTtsPcm(line.text, mapping.voiceId));
  }
  return { buffer: buildWavBuffer(concatenatePcmLines(pcmBuffers)), mimeType: 'audio/wav', extension: 'wav' };
}

async function generateAudioBuffer({ provider, lines, voiceMap }) {
  if (provider === 'stub') return synthesizeStubAudioScene(lines);
  if (provider === 'piper') return synthesizePiperScene(lines);
  if (provider === 'elevenlabs') return synthesizeElevenLabsScene(lines, voiceMap);
  throw new Error(`Unsupported audio provider: ${provider}`);
}

function fallbackDialogueForScene(scene) {
  return [{
    speaker: 'Narrator',
    text: cleanText(scene.beat, MAX_LINE_TEXT_LENGTH) || cleanText(scene.title, 200) || 'Narration.',
  }];
}

function cleanDialogueLines(rawLines) {
  return (Array.isArray(rawLines) ? rawLines : [])
    .map((line) => ({
      speaker: cleanText(line?.speaker, 80) || 'Narrator',
      text: cleanText(line?.text, MAX_LINE_TEXT_LENGTH),
    }))
    .filter((line) => line.text);
}

async function buildSceneDialogue({ scriptText, scenes, provider }) {
  const fallbackScenes = scenes.map((scene, index) => ({
    sceneNumber: scene.sceneNumber || index + 1,
    lines: fallbackDialogueForScene(scene),
  }));

  if (provider === 'stub') {
    return {
      scenesDialogue: fallbackScenes,
      speakers: ['Narrator'],
      usedFallback: true,
      warning: 'Stub text mode selected; local fallback dialogue was used.',
    };
  }

  const prompt = `You are extracting spoken dialogue for a storyboard video from a script, aligned to already-defined scenes.
Return strict JSON only in this shape:
{"scenes":[{"sceneNumber":1,"lines":[{"speaker":"Narrator","text":"..."}]}]}

Rules:
- Produce dialogue for exactly ${scenes.length} scenes, in order, each with at least one line.
- Detect character names from context; use "Narrator" only for text with no clear speaker.
- Reuse the exact same speaker name for the same character across scenes.
- Lines must be concise and voice-ready: no stage directions, no asterisks, no parentheticals.
- Scenes for alignment:
${scenes.map((scene, index) => `${index + 1}. ${scene.title || ''}: ${scene.beat || ''}`).join('\n')}
- Full story text for reference:
${scriptText}`;

  try {
    const raw = provider === 'openai' ? await callOpenAIText(prompt) : await callGeminiText(prompt);
    const parsed = extractJson(raw);
    if (!parsed?.scenes || !Array.isArray(parsed.scenes)) {
      return {
        scenesDialogue: fallbackScenes,
        speakers: ['Narrator'],
        usedFallback: true,
        warning: 'The provider returned invalid dialogue data; local fallback dialogue was used.',
      };
    }

    const scenesDialogue = fallbackScenes.map((fallbackScene, index) => {
      const lines = cleanDialogueLines(parsed.scenes[index]?.lines);
      return { sceneNumber: fallbackScene.sceneNumber, lines: lines.length ? lines : fallbackScene.lines };
    });
    const speakerSet = new Set();
    scenesDialogue.forEach((scene) => scene.lines.forEach((line) => speakerSet.add(line.speaker)));
    const usedFallback = parsed.scenes.length !== scenes.length;
    return {
      scenesDialogue,
      speakers: [...speakerSet],
      usedFallback,
      warning: usedFallback ? `The provider returned ${parsed.scenes.length} of ${scenes.length} scenes; local fallback filled the remainder.` : '',
    };
  } catch (error) {
    return {
      scenesDialogue: fallbackScenes,
      speakers: ['Narrator'],
      usedFallback: true,
      warning: `Provider unavailable; local fallback dialogue was used. ${cleanText(error.message, 300)}`,
    };
  }
}

async function regenerateSceneDialogue({ scriptText, scene, sceneIndex, provider, knownSpeakers = [] }) {
  const fallback = fallbackDialogueForScene(scene);
  if (provider === 'stub') {
    return { lines: fallback, usedFallback: true, warning: 'Stub text mode selected; fallback dialogue was retained.' };
  }

  const prompt = `Return strict JSON only in this shape: {"lines":[{"speaker":"...","text":"..."}]}.
Rewrite spoken dialogue for scene ${sceneIndex + 1}.
Story text: ${scriptText}
Scene title: ${scene.title || ''}
Scene beat: ${scene.beat || ''}
Known speaker names already used elsewhere (reuse if applicable): ${knownSpeakers.join(', ') || 'none'}
Lines must be concise and voice-ready: no stage directions, no asterisks.`;

  try {
    const raw = provider === 'openai' ? await callOpenAIText(prompt) : await callGeminiText(prompt);
    const parsed = extractJson(raw);
    const lines = cleanDialogueLines(parsed?.lines);
    if (!lines.length) {
      return { lines: fallback, usedFallback: true, warning: 'The provider returned invalid dialogue data; fallback dialogue was retained.' };
    }
    return { lines, usedFallback: false, warning: '' };
  } catch (error) {
    return {
      lines: fallback,
      usedFallback: true,
      warning: `Provider unavailable; fallback dialogue was retained. ${cleanText(error.message, 300)}`,
    };
  }
}

function detectImageExtension(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6))) return 'gif';
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: MAX_STYLE_REFERENCE_IMAGES, fileSize: MAX_REFERENCE_FILE_SIZE },
});

function createAssetResolver(baseDir, publicPrefix) {
  return function resolveAsset(publicPath) {
    if (typeof publicPath !== 'string' || !publicPath.startsWith(`${publicPrefix}/`)) return null;
    let fileName;
    try {
      fileName = decodeURIComponent(publicPath.slice(publicPrefix.length + 1));
    } catch (_) {
      return null;
    }
    if (!fileName || fileName !== path.basename(fileName) || fileName.includes('\\')) return null;
    const sourcePath = path.resolve(baseDir, fileName);
    if (path.dirname(sourcePath) !== path.resolve(baseDir)) return null;
    return { fileName, sourcePath };
  };
}

const resolveGeneratedAsset = createAssetResolver(GENERATED_DIR, '/generated');
const resolveAudioAsset = createAssetResolver(AUDIO_DIR, '/audio');
const resolveVideoAsset = createAssetResolver(VIDEO_DIR, '/videos');

function createStubVideoSource() {
  const configured = process.env.VIDEO_STUB_PATH ? path.resolve(process.env.VIDEO_STUB_PATH) : null;
  if (configured) {
    if (!fs.existsSync(configured)) throw new Error(`VIDEO_STUB_PATH does not exist: ${configured}`);
    return configured;
  }

  ensureDir(VIDEO_STUB_DIR);
  const stubPath = path.resolve(VIDEO_STUB_DIR, 'placeholder.mp4');
  if (!fs.existsSync(stubPath)) {
    // A tiny valid H.264 MP4 keeps stub previews browser-playable without invoking a codec at runtime.
    const placeholder = 'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAN2bW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAMgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAqB0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAMgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAEAAAABAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAADIAAAEAAABAAAAAAIYbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAyAAAACgBVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABw21pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAYNzdGJsAAAAv3N0c2QAAAAAAAAAAQAAAK9hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAQABIAAAASAAAAAAAAAABFUxhdmM2MC4zMS4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANWF2Y0MBZAAK/+EAGGdkAAqs2UQmwEQAAAMABAAAAwDIPEiWWAEABmjr48siwP34+AAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAACXaAAAl2gAAAAYc3R0cwAAAAAAAAABAAAABQAAAgAAAAAUc3RzcwAAAAAAAAABAAAAAQAAADhjdHRzAAAAAAAAAAUAAAABAAAEAAAAAAEAAAoAAAAAAQAABAAAAAABAAAAAAAAAAEAAAIAAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAAFAAAAAQAAAChzdHN6AAAAAAAAAAAAAAAFAAADlQAAAA4AAAAOAAAADAAAAAwAAAAUc3RjbwAAAAAAAAABAAADpgAAAGJ1ZHRhAAAAWm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALWlsc3QAAAAlqXRvbwAAAB1kYXRhAAAAAQAAAABMYXZmNjAuMTYuMTAwAAAACGZyZWUAAAPRbWRhdAAAAq4GBf//qtxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjQgcjMxMDggMzFlMTlmOSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjMgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0xIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDM6MHgxMTMgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMiBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0yIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTEgYl9iaWFzPTAgZGlyZWN0PTEgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0yIGtleWludD0yNTAga2V5aW50X21pbj0yNSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAN9liIQAM//+9uy+BTYUyFCXESzFpt8/STqFD8AAaF+d951JqIjoEbsv3rFxE+oRXpTttU4vqkNTd/i7HY4kw5McU2HooWX+txaa2EQhoRPPYT7eFgWggS+QGujZCgEUFDe2GtfDXSbqq8RNTYs6eewsiOtAoqXTBSHxzU+owBZlyIuS6C+OiHoGWyQHyZAE2x4aZXA6Avd6kh/nAWMhkObFVYlVWXVvaBuqnGIdBbS4/Wqgm2gxMI2NspbXjAsuAbx239iEr30Om4snZQD4/9tF60BTmuJhGPq9JtDnnSgdAAAACkGaJGxCv/44jcAAAAAKQZ5CeIX/Hmaw2wAAAAgBnmF0Qr8MOAAAAAgBnmNqQr8MOQ==';
    fs.writeFileSync(stubPath, Buffer.from(placeholder, 'base64'));
  }
  return stubPath;
}

async function generateVideoFile({ imagePath, prompt, outputFileName }) {
  ensureDir(VIDEO_DIR);
  const destinationPath = path.resolve(VIDEO_DIR, outputFileName);
  if (VIDEO_PROVIDER === 'stub') {
    fs.copyFileSync(createStubVideoSource(), destinationPath);
    return destinationPath;
  }

  ensureDir(LTX_SHARED_DIR);
  const sourceExtension = path.extname(imagePath).toLowerCase() || '.png';
  const stagedImagePath = path.resolve(LTX_SHARED_DIR, `${path.parse(outputFileName).name}-source${sourceExtension}`);
  const stagedOutputPath = path.resolve(LTX_SHARED_DIR, outputFileName);
  fs.copyFileSync(path.resolve(imagePath), stagedImagePath);

  try {
    const response = await fetch(ltxUrl(process.env.LTX_VIDEO_GENERATE_PATH || '/generate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: cleanText(prompt, MAX_PROMPT_LENGTH),
        negative_prompt: cleanText(
          process.env.VIDEO_NEGATIVE_PROMPT || 'flicker, jitter, blurry, warped anatomy, extra limbs, duplicate characters, text, watermark',
          MAX_PROMPT_LENGTH,
        ),
        image: stagedImagePath,
        width: videoDimensionSetting('VIDEO_WIDTH', 640),
        height: videoDimensionSetting('VIDEO_HEIGHT', 480),
        frames: videoFrameSetting(),
        steps: videoIntegerSetting('VIDEO_STEPS', 30, 1, 100),
        seed: videoIntegerSetting('VIDEO_SEED', 42, 0, 2 ** 31 - 1),
        output: stagedOutputPath,
      }),
      signal: videoTimeout(process.env.VIDEO_PROVIDER_TIMEOUT_MS, 10 * 60_000),
    });
    const raw = await response.text();
    let result = {};
    try { result = raw ? JSON.parse(raw) : {}; } catch (_) {}
    if (!response.ok) {
      const providerError = result?.error || {};
      const error = new Error(cleanText(providerError.message || raw, 500) || `LTX-Video returned HTTP ${response.status}`);
      error.statusCode = response.status;
      error.code = providerError.code || 'LTX_ERROR';
      error.retryable = providerError.retryable === true;
      throw error;
    }
    if (!fs.existsSync(stagedOutputPath)) {
      throw new Error(`LTX-Video completed without creating ${stagedOutputPath}`);
    }
    fs.copyFileSync(stagedOutputPath, destinationPath);
    return destinationPath;
  } finally {
    if (fs.existsSync(stagedImagePath)) fs.unlinkSync(stagedImagePath);
    if (fs.existsSync(stagedOutputPath)) fs.unlinkSync(stagedOutputPath);
  }
}

app.get('/api/styles', (req, res) => {
  res.json({ styles: listStyles() });
});

app.get('/api/videos/preflight', async (req, res) => {
  try {
    const result = await verifyVideoProvider();
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 503).json({
      ok: false,
      error: { code: error.code || 'NOT_READY', message: error.message, retryable: error.retryable !== false },
    });
  }
});

app.get('/api/styles/:styleId/references', (req, res) => {
  const styleId = sanitizeStyleId(req.params.styleId || 'basic-cartoon');
  if (!findStyleById(styleId)) return res.status(404).json({ error: 'Unknown style' });
  res.json({ styleId, references: listStyleReferences(styleId) });
});

app.post('/api/styles/:styleId/references/upload', upload.array('files', MAX_STYLE_REFERENCE_IMAGES), (req, res) => {
  const styleId = sanitizeStyleId(req.params.styleId || 'basic-cartoon');
  if (!findStyleById(styleId)) return res.status(404).json({ ok: false, error: 'Unknown style' });
  const type = normalizeRefType(req.query.type || req.body.type || 'characters');
  const existing = listReferenceFiles(styleId, type);
  if (!req.files?.length) return res.status(400).json({ ok: false, error: 'At least one image is required' });
  if (existing.length + req.files.length > MAX_STYLE_REFERENCE_IMAGES) {
    return res.status(400).json({ ok: false, error: `A style can have at most ${MAX_STYLE_REFERENCE_IMAGES} ${type} references.` });
  }

  const prepared = req.files.map((file) => ({ file, extension: detectImageExtension(file.buffer) }));
  if (prepared.some((item) => !item.extension)) {
    return res.status(400).json({ ok: false, error: 'Only valid PNG, JPEG, WebP, and GIF images are accepted.' });
  }

  const dir = getStyleReferenceDir(styleId, type);
  ensureDir(dir);
  prepared.forEach(({ file, extension }, index) => {
    const originalExt = path.extname(file.originalname);
    const base = slugify(path.basename(file.originalname, originalExt));
    const fileName = `${Date.now()}-${index}-${base}.${extension}`;
    fs.writeFileSync(path.join(dir, fileName), file.buffer);
  });
  res.json({ ok: true, styleId, references: listStyleReferences(styleId) });
});

app.delete('/api/styles/:styleId/references', (req, res) => {
  try {
    const styleId = sanitizeStyleId(req.params.styleId || 'basic-cartoon');
    if (!findStyleById(styleId)) return res.status(404).json({ ok: false, error: 'Unknown style' });
    const type = normalizeRefType(req.body.type || 'characters');
    const fileName = path.basename(req.body.fileName || '');
    if (!fileName) return res.status(400).json({ ok: false, error: 'fileName required' });
    const filePath = path.join(getStyleReferenceDir(styleId, type), fileName);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.json({ ok: true, styleId, references: listStyleReferences(styleId) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'Delete failed' });
  }
});

app.post('/api/storyboard/generate-prompts', async (req, res) => {
  const { scriptText = '', sceneCount = 6, styleId = 'basic-cartoon', commonPromptText = '', provider = 'gemini' } = req.body || {};
  const style = findStyleById(styleId);
  if (!style) return res.status(400).json({ error: 'Unknown style' });
  if (!TEXT_PROVIDERS.has(provider)) return res.status(400).json({ error: 'Unknown text provider' });
  const cleanScript = cleanText(scriptText, MAX_SCRIPT_LENGTH);
  if (!cleanScript) return res.status(400).json({ error: 'Story text is required' });
  const count = clampSceneCount(sceneCount);
  const result = await buildScenePrompts({
    scriptText: cleanScript,
    sceneCount: count,
    style,
    commonPromptText: cleanText(commonPromptText, MAX_PROMPT_LENGTH),
    provider,
  });
  res.json({ ...result, style });
});

app.post('/api/storyboard/regenerate-prompt', async (req, res) => {
  const { scriptText = '', scene = {}, sceneIndex = 0, styleId = 'basic-cartoon', commonPromptText = '', provider = 'gemini', extraPromptText = '' } = req.body || {};
  const style = findStyleById(styleId);
  if (!style) return res.status(400).json({ error: 'Unknown style' });
  if (!TEXT_PROVIDERS.has(provider)) return res.status(400).json({ error: 'Unknown text provider' });
  const result = await regenerateSinglePrompt({
    scriptText: cleanText(scriptText, MAX_SCRIPT_LENGTH),
    scene,
    sceneIndex: Math.max(0, Number.parseInt(sceneIndex, 10) || 0),
    style,
    commonPromptText: cleanText(commonPromptText, MAX_PROMPT_LENGTH),
    provider,
    extraPromptText: cleanText(extraPromptText, MAX_PROMPT_LENGTH),
  });
  res.json(result);
});

app.post('/api/storyboard/generate-dialogue', async (req, res) => {
  const { scriptText = '', scenes = [], provider = 'gemini' } = req.body || {};
  if (!TEXT_PROVIDERS.has(provider)) return res.status(400).json({ error: 'Unknown text provider' });
  if (!Array.isArray(scenes) || !scenes.length) return res.status(400).json({ error: 'Scenes are required' });
  const result = await buildSceneDialogue({
    scriptText: cleanText(scriptText, MAX_SCRIPT_LENGTH),
    scenes,
    provider,
  });
  res.json(result);
});

app.post('/api/storyboard/regenerate-dialogue', async (req, res) => {
  const { scriptText = '', scene = {}, sceneIndex = 0, provider = 'gemini', knownSpeakers = [] } = req.body || {};
  if (!TEXT_PROVIDERS.has(provider)) return res.status(400).json({ error: 'Unknown text provider' });
  const result = await regenerateSceneDialogue({
    scriptText: cleanText(scriptText, MAX_SCRIPT_LENGTH),
    scene,
    sceneIndex: Math.max(0, Number.parseInt(sceneIndex, 10) || 0),
    provider,
    knownSpeakers: Array.isArray(knownSpeakers) ? knownSpeakers.slice(0, 50).map((x) => cleanText(x, 80)) : [],
  });
  res.json(result);
});

app.post('/api/images/generate', async (req, res) => {
  try {
    const {
      sceneNumber = 1,
      sceneTitle = '',
      scenePrompt = '',
      styleId = 'basic-cartoon',
      commonPromptText = '',
      extraPromptText = '',
      provider = 'gemini',
    } = req.body || {};

    const style = findStyleById(styleId);
    if (!style) return res.status(400).json({ ok: false, error: 'Unknown style' });
    if (!IMAGE_PROVIDERS.has(provider)) return res.status(400).json({ ok: false, error: 'Unknown image provider' });
    const referencePaths = getStyleReferencePaths(style.id);
    const usedReferencePaths = provider === 'gemini' ? referencePaths : [];
    const additionalPromptText = getAdditionalCommonPrompt(style.promptText, commonPromptText);
    const finalPrompt = [
      `Style direction: ${style.promptText}`,
      usedReferencePaths.length ? 'Attached reference images define recurring characters and world consistency.' : '',
      additionalPromptText,
      cleanText(scenePrompt, MAX_PROMPT_LENGTH),
      cleanText(extraPromptText, MAX_PROMPT_LENGTH),
    ]
      .map((x) => String(x || '').trim())
      .filter(Boolean)
      .join('\n\n');

    if (!cleanText(scenePrompt, MAX_PROMPT_LENGTH)) return res.status(400).json({ ok: false, error: 'Scene prompt is required' });
    const imageResult = await generateImageBuffer({ provider, finalPrompt, referencePaths: usedReferencePaths, sceneTitle: cleanText(sceneTitle, 200) });
    ensureDir(GENERATED_DIR);
    const filename = `${String(sceneNumber).padStart(2, '0')}-${slugify(sceneTitle || 'scene')}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${imageResult.extension}`;
    const outPath = path.join(GENERATED_DIR, filename);
    fs.writeFileSync(outPath, imageResult.buffer);

    res.json({
      ok: true,
      image: {
        fileName: filename,
        path: `/generated/${filename}`,
        prompt: finalPrompt,
        mimeType: imageResult.mimeType,
      },
      referenceCount: usedReferencePaths.length,
    });
  } catch (error) {
    if (error.retryAfter) res.set('Retry-After', error.retryAfter);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message || 'Image generation failed' });
  }
});

app.post('/api/videos/generate', async (req, res) => {
  try {
    const { sceneNumber = 1, sceneTitle = '', scenePrompt = '', imagePath = '' } = req.body || {};
    const source = resolveGeneratedAsset(imagePath);
    if (!source || !fs.existsSync(source.sourcePath)) {
      return res.status(400).json({
        ok: false,
        error: { code: 'INVALID_PATH', message: 'A valid generated reference image is required', retryable: false },
      });
    }
    await verifyVideoProvider();
    const filename = `${String(sceneNumber).padStart(2, '0')}-${slugify(sceneTitle || 'scene')}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.mp4`;
    await generateVideoFile({
      imagePath: path.resolve(source.sourcePath),
      prompt: cleanText(scenePrompt, MAX_PROMPT_LENGTH),
      outputFileName: filename,
    });
    res.json({
      ok: true,
      video: {
        fileName: filename,
        path: `/videos/${filename}`,
        sourceImagePath: imagePath,
        prompt: cleanText(scenePrompt, MAX_PROMPT_LENGTH),
        mimeType: 'video/mp4',
        provider: VIDEO_PROVIDER,
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      ok: false,
      error: {
        code: error.code || 'VIDEO_GENERATION_FAILED',
        message: error.message || 'Video generation failed',
        retryable: error.retryable === true,
      },
    });
  }
});

app.post('/api/audio/generate', async (req, res) => {
  try {
    const { sceneNumber = 1, sceneTitle = '', lines = [], provider = 'stub', voiceMap = {} } = req.body || {};
    if (!AUDIO_PROVIDERS.has(provider)) return res.status(400).json({ ok: false, error: 'Unknown audio provider' });
    const cleanedLines = cleanDialogueLines(lines);
    if (!cleanedLines.length) return res.status(400).json({ ok: false, error: 'At least one dialogue line is required' });

    const audioResult = await generateAudioBuffer({ provider, lines: cleanedLines, voiceMap: voiceMap && typeof voiceMap === 'object' ? voiceMap : {} });
    ensureDir(AUDIO_DIR);
    const filename = `${String(sceneNumber).padStart(2, '0')}-${slugify(sceneTitle || 'scene')}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${audioResult.extension}`;
    fs.writeFileSync(path.join(AUDIO_DIR, filename), audioResult.buffer);

    res.json({
      ok: true,
      audio: {
        fileName: filename,
        path: `/audio/${filename}`,
        mimeType: audioResult.mimeType,
        provider,
      },
    });
  } catch (error) {
    if (error.retryAfter) res.set('Retry-After', error.retryAfter);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message || 'Audio generation failed' });
  }
});

app.get('/api/audio/voices', async (req, res) => {
  const provider = String(req.query.provider || '');
  if (provider !== 'elevenlabs') return res.status(400).json({ ok: false, error: 'Unsupported voice-list provider' });
  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) return res.status(400).json({ ok: false, error: 'ELEVENLABS_API_KEY missing' });
    const response = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': apiKey },
      signal: providerTimeout(process.env.AUDIO_PROVIDER_TIMEOUT_MS || 60_000),
    });
    if (!response.ok) await throwProviderResponseError('elevenlabs', response);
    const data = await response.json();
    res.json({
      ok: true,
      provider,
      voices: (data.voices || []).map((voice) => ({ voiceId: voice.voice_id, label: voice.name })),
    });
  } catch (error) {
    if (error.retryAfter) res.set('Retry-After', error.retryAfter);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message || 'Voice list failed' });
  }
});

app.post('/api/images/zip', async (req, res) => {
  try {
    const project = req.body?.project && typeof req.body.project === 'object' ? req.body.project : { scenes: req.body?.scenes || [] };
    const scenes = Array.isArray(project.scenes) ? project.scenes.slice(0, 50) : [];
    ensureDir(ZIP_DIR);
    const zipName = `storyboard-images-${Date.now()}.zip`;
    const zipPath = path.join(ZIP_DIR, zipName);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    await new Promise((resolve, reject) => {
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);
      archive.pipe(output);

      scenes.forEach((scene, index) => {
        const activeIndex = Number.isInteger(scene.activeVersionIndex) ? scene.activeVersionIndex : 0;
        const active = Array.isArray(scene.versions) ? scene.versions[activeIndex] : null;
        const asset = resolveGeneratedAsset(active?.path);
        if (!asset || !fs.existsSync(asset.sourcePath)) return;
        const sceneNum = String(index + 1).padStart(2, '0');
        const extension = path.extname(asset.fileName).toLowerCase() || '.png';
        archive.file(asset.sourcePath, { name: `${sceneNum}-${slugify(scene.title || 'scene')}${extension}` });

        const activeVideoIndex = Number.isInteger(scene.activeVideoVersionIndex) ? scene.activeVideoVersionIndex : 0;
        const activeVideo = Array.isArray(scene.videoVersions) ? scene.videoVersions[activeVideoIndex] : null;
        const videoAsset = resolveVideoAsset(activeVideo?.path);
        if (videoAsset && fs.existsSync(videoAsset.sourcePath)) {
          archive.file(videoAsset.sourcePath, { name: `${sceneNum}-${slugify(scene.title || 'scene')}.mp4` });
        }

        const activeAudioIndex = Number.isInteger(scene.activeAudioVersionIndex) ? scene.activeAudioVersionIndex : 0;
        const activeAudio = Array.isArray(scene.audioVersions) ? scene.audioVersions[activeAudioIndex] : null;
        const audioAsset = resolveAudioAsset(activeAudio?.path);
        if (!audioAsset || !fs.existsSync(audioAsset.sourcePath)) return;
        const audioExtension = path.extname(audioAsset.fileName).toLowerCase() || '.wav';
        archive.file(audioAsset.sourcePath, { name: `${sceneNum}-${slugify(scene.title || 'scene')}${audioExtension}` });
      });

      const manifest = {
        ...project,
        scenes: scenes.map((scene) => ({ ...scene })),
        exportedAt: new Date().toISOString(),
      };
      archive.append(JSON.stringify(manifest, null, 2), { name: 'storyboard.json' });
      archive.finalize().catch(reject);
    });
    res.json({ ok: true, zipPath: `/downloads/${zipName}` });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'Zip generation failed' });
  }
});

app.use('/downloads', express.static(ZIP_DIR));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ ok: false, error: error.code === 'LIMIT_FILE_SIZE' ? 'Reference images must be 8 MB or smaller.' : error.message });
  }
  res.status(500).json({ ok: false, error: cleanText(error.message, 300) || 'Unexpected server error' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Storyboard POC running on http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  buildScenePrompts,
  buildSceneDialogue,
  buildWavBuffer,
  clampSceneCount,
  concatenatePcmLines,
  createProviderError,
  getAdditionalCommonPrompt,
  regenerateSceneDialogue,
  regenerateSinglePrompt,
  resolveAudioAsset,
  resolveGeneratedAsset,
  resolveVideoAsset,
  splitIntoScenes,
  verifyVideoProvider,
};
