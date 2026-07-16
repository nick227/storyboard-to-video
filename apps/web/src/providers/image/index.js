const { signal, throwResponse } = require('../http');
const { stubImage } = require('../../media/stub-media');

function createImageProviders(config, textProviders, getCancellation) {
  async function openai(prompt) {
    if (!config.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
    const response = await fetch('https://api.openai.com/v1/images/generations', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.env.OPENAI_API_KEY}` }, body: JSON.stringify({ model: config.env.OPENAI_IMAGE_MODEL || 'gpt-image-1', prompt, size: '1024x1024' }), signal: signal(config.env.IMAGE_PROVIDER_TIMEOUT_MS || 180_000, getCancellation) });
    if (!response.ok) await throwResponse('openai', response); const data = await response.json(); if (!data.data?.[0]?.b64_json) throw new Error('OpenAI image error: no image returned'); return { buffer: Buffer.from(data.data[0].b64_json, 'base64'), mimeType: 'image/png', extension: 'png' };
  }
  async function dezgo(prompt) {
    if (!config.env.DEZGO_API_KEY) throw new Error('DEZGO_API_KEY missing');
    const body = new URLSearchParams({ prompt, width: '1024', height: '1024', guidance: config.env.DEZGO_GUIDANCE || '7', steps: config.env.DEZGO_STEPS || '25', sampler: config.env.DEZGO_SAMPLER || 'euler_a', negative_prompt: 'blurry, unreadable, overly detailed, deformed' });
    const response = await fetch('https://api.dezgo.com/text2image', { method: 'POST', headers: { 'X-Dezgo-Key': config.env.DEZGO_API_KEY, Accept: 'image/png', 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: signal(config.env.IMAGE_PROVIDER_TIMEOUT_MS || 180_000, getCancellation) });
    if (!response.ok) await throwResponse('dezgo', response); return { buffer: Buffer.from(await response.arrayBuffer()), mimeType: 'image/png', extension: 'png' };
  }
  async function gemini(prompt, references) {
    if (!config.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing'); const model = config.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.env.GEMINI_API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: textProviders.geminiParts(prompt, references) }], generationConfig: { temperature: 0.7, responseModalities: ['TEXT','IMAGE'] } }), signal: signal(config.env.IMAGE_PROVIDER_TIMEOUT_MS || 180_000, getCancellation) });
    if (!response.ok) await throwResponse('gemini', response); const data = await response.json(); const part = (data.candidates?.[0]?.content?.parts || []).find((item) => item.inlineData?.data || item.inline_data?.data); const b64 = part?.inlineData?.data || part?.inline_data?.data; if (!b64) throw new Error('Gemini image error: no image returned'); const mimeType = part?.inlineData?.mimeType || part?.inline_data?.mime_type || 'image/png'; return { buffer: Buffer.from(b64, 'base64'), mimeType, extension: mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png' };
  }
  return { generate: ({ provider, prompt, references = [], title }) => provider === 'stub' ? Promise.resolve({ buffer: stubImage(prompt, title), mimeType: 'image/svg+xml', extension: 'svg' }) : provider === 'openai' ? openai(prompt) : provider === 'dezgo' ? dezgo(prompt) : gemini(prompt, references) };
}
module.exports = { createImageProviders };
