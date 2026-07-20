const { signal, throwResponse } = require('../http');
const { stubImage } = require('../../media/stub-media');
const { providerRequestId, providerResult } = require('../result');
const fs = require('node:fs');

function fileBlob(file) {
  const extension = file.split('.').pop()?.toLowerCase();
  const mimeType = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : extension === 'webp' ? 'image/webp' : extension === 'gif' ? 'image/gif' : 'image/png';
  return new Blob([fs.readFileSync(file)], { type: mimeType });
}

function createImageProviders(config, textProviders, getCancellation, usageTracker) {
  async function openai(prompt, references = []) {
    if (!config.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
    const size = config.env.OPENAI_IMAGE_SIZE || '1024x1024'; const quality = config.env.OPENAI_IMAGE_QUALITY || 'medium';
    const model = config.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
    let url = 'https://api.openai.com/v1/images/generations';
    let headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${config.env.OPENAI_API_KEY}` };
    let body = JSON.stringify({ model, prompt, size, quality });
    if (references.length) {
      url = 'https://api.openai.com/v1/images/edits';
      headers = { Authorization: `Bearer ${config.env.OPENAI_API_KEY}` };
      const form = new FormData();
      form.append('model', model); form.append('prompt', prompt); form.append('size', size); form.append('quality', quality);
      references.slice(0, 8).forEach((file, index) => form.append('image[]', fileBlob(file), `reference-${index}.${file.split('.').pop() || 'png'}`));
      body = form;
    }
    const response = await fetch(url, { method: 'POST', headers, body, signal: signal(config.env.IMAGE_PROVIDER_TIMEOUT_MS || 180_000, getCancellation) });
    if (!response.ok) await throwResponse('openai', response); const data = await response.json(); if (!data.data?.[0]?.b64_json) throw new Error('OpenAI image error: no image returned'); const rawUsage = data.usage || null; return providerResult({ output: { buffer: Buffer.from(data.data[0].b64_json, 'base64'), mimeType: 'image/png', extension: 'png' }, provider: 'openai', model: config.env.OPENAI_IMAGE_MODEL || 'gpt-image-1', providerRequestId: providerRequestId(response, data), settings: { size, quality, mode: references.length ? 'edit' : 'generate' }, usage: { images: 1, size, quality, ...(rawUsage ? { inputTokens: rawUsage.input_tokens || 0, inputTextTokens: rawUsage.input_tokens_details?.text_tokens || 0, inputImageTokens: rawUsage.input_tokens_details?.image_tokens || 0, outputTokens: rawUsage.output_tokens || 0, outputImageTokens: rawUsage.output_tokens_details?.image_tokens || rawUsage.output_tokens || 0, totalTokens: rawUsage.total_tokens || 0, serviceTier: 'standard' } : {}) }, rawUsage, measurementStatus: rawUsage ? 'observed' : 'estimated' });
  }
  async function dezgo(prompt, references = []) {
    if (!config.env.DEZGO_API_KEY) throw new Error('DEZGO_API_KEY missing');
    const common = { prompt, guidance: config.env.DEZGO_GUIDANCE || '7', steps: config.env.DEZGO_STEPS || '25', sampler: config.env.DEZGO_SAMPLER || 'euler_a', negative_prompt: 'blurry, unreadable, overly detailed, deformed' };
    let url = 'https://api.dezgo.com/text2image';
    let headers = { 'X-Dezgo-Key': config.env.DEZGO_API_KEY, Accept: 'image/png', 'Content-Type': 'application/x-www-form-urlencoded' };
    let body = new URLSearchParams({ ...common, width: '1024', height: '1024' });
    if (references.length) {
      url = 'https://api.dezgo.com/image2image';
      headers = { 'X-Dezgo-Key': config.env.DEZGO_API_KEY, Accept: 'image/png' };
      const form = new FormData();
      Object.entries(common).forEach(([key, value]) => form.append(key, value));
      form.append('strength', config.env.DEZGO_REFERENCE_STRENGTH || '0.65');
      form.append('init_image', fileBlob(references[0]), `reference.${references[0].split('.').pop() || 'png'}`);
      body = form;
    }
    const response = await fetch(url, { method: 'POST', headers, body, signal: signal(config.env.IMAGE_PROVIDER_TIMEOUT_MS || 180_000, getCancellation) });
    if (!response.ok) await throwResponse('dezgo', response); return providerResult({ output: { buffer: Buffer.from(await response.arrayBuffer()), mimeType: 'image/png', extension: 'png' }, provider: 'dezgo', model: config.env.DEZGO_MODEL || 'text2image', providerRequestId: providerRequestId(response), settings: { width: 1024, height: 1024, steps: Number(config.env.DEZGO_STEPS || 25), guidance: Number(config.env.DEZGO_GUIDANCE || 7), sampler: config.env.DEZGO_SAMPLER || 'euler_a', mode: references.length ? 'image_to_image' : 'text_to_image', ...(references.length ? { strength: Number(config.env.DEZGO_REFERENCE_STRENGTH || 0.65) } : {}) }, usage: { images: 1, width: 1024, height: 1024, steps: Number(config.env.DEZGO_STEPS || 25), guidance: Number(config.env.DEZGO_GUIDANCE || 7), sampler: config.env.DEZGO_SAMPLER || 'euler_a' }, rawUsage: { inputSeed: response.headers.get('x-input-seed') || null }, measurementStatus: 'estimated' });
  }
  async function gemini(prompt, references) {
    if (!config.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing'); const model = config.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.env.GEMINI_API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: textProviders.geminiParts(prompt, references) }], generationConfig: { temperature: 0.7, responseModalities: ['TEXT','IMAGE'] } }), signal: signal(config.env.IMAGE_PROVIDER_TIMEOUT_MS || 180_000, getCancellation) });
    if (!response.ok) await throwResponse('gemini', response); const data = await response.json(); const part = (data.candidates?.[0]?.content?.parts || []).find((item) => item.inlineData?.data || item.inline_data?.data); const b64 = part?.inlineData?.data || part?.inline_data?.data; if (!b64) throw new Error('Gemini image error: no image returned'); const mimeType = part?.inlineData?.mimeType || part?.inline_data?.mime_type || 'image/png'; const rawUsage = data.usageMetadata || null; const outputImageTokens = (rawUsage?.candidatesTokensDetails || []).filter((item) => item.modality === 'IMAGE').reduce((sum, item) => sum + (item.tokenCount || 0), 0); const candidateTokens = rawUsage?.candidatesTokenCount || 0; return providerResult({ output: { buffer: Buffer.from(b64, 'base64'), mimeType, extension: mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png' }, provider: 'gemini', model: data.modelVersion || model, providerRequestId: providerRequestId(response, data), settings: { temperature: 0.7, responseModalities: ['TEXT', 'IMAGE'] }, usage: { images: 1, ...(rawUsage ? { inputTokens: rawUsage.promptTokenCount || 0, cachedInputTokens: rawUsage.cachedContentTokenCount || 0, outputTokens: candidateTokens + (rawUsage.thoughtsTokenCount || 0), candidateTokens, outputImageTokens, outputTextOrThinkingTokens: Math.max(0, candidateTokens - outputImageTokens) + (rawUsage.thoughtsTokenCount || 0), thinkingTokens: rawUsage.thoughtsTokenCount || 0, totalTokens: rawUsage.totalTokenCount || 0, serviceTier: rawUsage.serviceTier || 'standard' } : {}) }, rawUsage, measurementStatus: rawUsage ? 'observed' : 'estimated' });
  }
  function generate({ provider, prompt, references = [], referenceBindings = [], title }) {
    const models = { stub: 'stub-image-v1', openai: config.env.OPENAI_IMAGE_MODEL || 'gpt-image-1', dezgo: config.env.DEZGO_MODEL || 'text2image', gemini: config.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image' };
    const operation = () => provider === 'stub'
      ? Promise.resolve(providerResult({ output: { buffer: stubImage(prompt, title), mimeType: 'image/svg+xml', extension: 'svg' }, provider: 'stub', model: models.stub, settings: { renderer: 'stub-svg-v1' }, usage: { images: 1 }, measurementStatus: 'not_applicable' }))
      : provider === 'openai' ? openai(prompt, references) : provider === 'dezgo' ? dezgo(prompt, references) : gemini(prompt, (referenceBindings.length ? referenceBindings : references).slice(0, 14));
    return usageTracker ? usageTracker.execute({ modality: 'image', provider, model: models[provider], inputMetadata: { promptCharacters: String(prompt).length, referenceCount: references.length } }, operation) : operation();
  }
  return { generate };
}
module.exports = { createImageProviders };
