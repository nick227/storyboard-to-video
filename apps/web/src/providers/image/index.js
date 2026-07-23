const { signal, throwResponse } = require('../http');
const { stubImage } = require('../../media/stub-media');
const { providerRequestId, providerResult } = require('../result');
const { IMAGE_PROVIDER_CAPABILITIES, imageProviderCapabilities } = require('../../shared/image-reference-plan');
const fs = require('node:fs');
const { estimatedUsage } = require('../../shared/media-output-policy');
const { AppError } = require('../../errors');
const { DEZGO_SD1_DEFAULT_STEPS, DEZGO_SD1_MODEL, dezgoModel, dezgoSteps, isDezgoFlux } = require('./dezgo-settings');

function fileBlob(file) {
  const extension = file.split('.').pop()?.toLowerCase();
  const mimeType = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : extension === 'webp' ? 'image/webp' : extension === 'gif' ? 'image/gif' : 'image/png';
  return new Blob([fs.readFileSync(file)], { type: mimeType });
}

function createImageProviders(config, textProviders, getCancellation, usageTracker, providerAdmission) {
  async function openai(prompt, references = [], output) {
    if (!config.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
    const { size, quality } = output.resolved.providerSettings;
    const model = config.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
    let url = 'https://api.openai.com/v1/images/generations';
    let headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${config.env.OPENAI_API_KEY}` };
    let body = JSON.stringify({ model, prompt, size, quality });
    if (references.length) {
      url = 'https://api.openai.com/v1/images/edits';
      headers = { Authorization: `Bearer ${config.env.OPENAI_API_KEY}` };
      const form = new FormData();
      form.append('model', model); form.append('prompt', prompt); form.append('size', size); form.append('quality', quality);
      references.forEach((file, index) => form.append('image[]', fileBlob(file), `reference-${index}.${file.split('.').pop() || 'png'}`));
      body = form;
    }
    const response = await fetch(url, { method: 'POST', headers, body, signal: signal(config.env.IMAGE_PROVIDER_TIMEOUT_MS || 180_000, getCancellation) });
    if (!response.ok) await throwResponse('openai', response); const data = await response.json(); if (!data.data?.[0]?.b64_json) throw new Error('OpenAI image error: no image returned'); const rawUsage = data.usage || null; return providerResult({ output: { buffer: Buffer.from(data.data[0].b64_json, 'base64'), mimeType: 'image/png', extension: 'png' }, provider: 'openai', model: config.env.OPENAI_IMAGE_MODEL || 'gpt-image-1', providerRequestId: providerRequestId(response, data), settings: { output, mode: references.length ? 'edit' : 'generate' }, usage: { images: 1, size, quality, ...estimatedUsage(output), ...(rawUsage ? { inputTokens: rawUsage.input_tokens || 0, inputTextTokens: rawUsage.input_tokens_details?.text_tokens || 0, inputImageTokens: rawUsage.input_tokens_details?.image_tokens || 0, outputTokens: rawUsage.output_tokens || 0, outputImageTokens: rawUsage.output_tokens_details?.image_tokens || rawUsage.output_tokens || 0, totalTokens: rawUsage.total_tokens || 0, serviceTier: 'standard' } : {}) }, rawUsage, measurementStatus: rawUsage ? 'observed' : 'estimated' });
  }
  async function dezgoSd1Image2Image(prompt, reference, output, steps) {
    const { width, height } = output.resolved.providerSettings;
    const common = {
      prompt,
      guidance: config.env.DEZGO_GUIDANCE || '7',
      steps: String(steps),
      sampler: config.env.DEZGO_SAMPLER || 'euler_a',
      negative_prompt: 'blurry, unreadable, overly detailed, deformed',
    };
    const form = new FormData();
    Object.entries(common).forEach(([key, value]) => form.append(key, value));
    form.append('width', String(width));
    form.append('height', String(height));
    form.append('strength', config.env.DEZGO_REFERENCE_STRENGTH || '0.65');
    form.append('init_image', fileBlob(reference), `reference.${reference.split('.').pop() || 'png'}`);
    const response = await fetch('https://api.dezgo.com/image2image', {
      method: 'POST',
      headers: { 'X-Dezgo-Key': config.env.DEZGO_API_KEY, Accept: 'image/png' },
      body: form,
      signal: signal(config.env.IMAGE_PROVIDER_TIMEOUT_MS || 180_000, getCancellation),
    });
    if (!response.ok) await throwResponse('dezgo', response);
    return providerResult({
      output: { buffer: Buffer.from(await response.arrayBuffer()), mimeType: 'image/png', extension: 'png' },
      provider: 'dezgo',
      model: DEZGO_SD1_MODEL,
      providerRequestId: providerRequestId(response),
      settings: {
        output,
        steps,
        guidance: Number(config.env.DEZGO_GUIDANCE || 7),
        sampler: config.env.DEZGO_SAMPLER || 'euler_a',
        mode: 'image_to_image',
        strength: Number(config.env.DEZGO_REFERENCE_STRENGTH || 0.65),
      },
      usage: {
        images: 1,
        ...estimatedUsage(output),
        steps,
        guidance: Number(config.env.DEZGO_GUIDANCE || 7),
        sampler: config.env.DEZGO_SAMPLER || 'euler_a',
      },
      rawUsage: { inputSeed: response.headers.get('x-input-seed') || null },
      measurementStatus: 'estimated',
    });
  }
  async function dezgoFlux(prompt, output, model, steps) {
    const { width, height } = output.resolved.providerSettings;
    const response = await fetch('https://api.dezgo.com/text2image_flux', {
      method: 'POST',
      headers: {
        'X-Dezgo-Key': config.env.DEZGO_API_KEY,
        Accept: 'image/png',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prompt, model, width, height, steps, format: 'png' }),
      signal: signal(config.env.IMAGE_PROVIDER_TIMEOUT_MS || 180_000, getCancellation),
    });
    if (!response.ok) await throwResponse('dezgo', response);
    return providerResult({
      output: { buffer: Buffer.from(await response.arrayBuffer()), mimeType: 'image/png', extension: 'png' },
      provider: 'dezgo',
      model,
      providerRequestId: providerRequestId(response),
      settings: { output, steps, mode: 'text_to_image', format: 'png' },
      usage: { images: 1, ...estimatedUsage(output), steps },
      rawUsage: { inputSeed: response.headers.get('x-input-seed') || null },
      measurementStatus: 'estimated',
    });
  }
  async function dezgoSd1Text2Image(prompt, output, steps) {
    const { width, height } = output.resolved.providerSettings;
    const body = new URLSearchParams({
      prompt,
      guidance: config.env.DEZGO_GUIDANCE || '7',
      steps: String(steps),
      sampler: config.env.DEZGO_SAMPLER || 'euler_a',
      negative_prompt: 'blurry, unreadable, overly detailed, deformed',
      width: String(width),
      height: String(height),
    });
    const response = await fetch('https://api.dezgo.com/text2image', {
      method: 'POST',
      headers: {
        'X-Dezgo-Key': config.env.DEZGO_API_KEY,
        Accept: 'image/png',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: signal(config.env.IMAGE_PROVIDER_TIMEOUT_MS || 180_000, getCancellation),
    });
    if (!response.ok) await throwResponse('dezgo', response);
    return providerResult({
      output: { buffer: Buffer.from(await response.arrayBuffer()), mimeType: 'image/png', extension: 'png' },
      provider: 'dezgo',
      model: DEZGO_SD1_MODEL,
      providerRequestId: providerRequestId(response),
      settings: {
        output,
        steps,
        guidance: Number(config.env.DEZGO_GUIDANCE || 7),
        sampler: config.env.DEZGO_SAMPLER || 'euler_a',
        mode: 'text_to_image',
      },
      usage: {
        images: 1,
        ...estimatedUsage(output),
        steps,
        guidance: Number(config.env.DEZGO_GUIDANCE || 7),
        sampler: config.env.DEZGO_SAMPLER || 'euler_a',
      },
      rawUsage: { inputSeed: response.headers.get('x-input-seed') || null },
      measurementStatus: 'estimated',
    });
  }
  async function dezgo(prompt, references = [], output) {
    if (!config.env.DEZGO_API_KEY) throw new Error('DEZGO_API_KEY missing');
    const model = dezgoModel(config.env);
    // Flux has no image2image on Dezgo — keep SD1 for reference-anchored generations.
    if (references.length) {
      const sd1Steps = config.env.DEZGO_STEPS != null && String(config.env.DEZGO_STEPS).trim() !== ''
        ? Number(config.env.DEZGO_STEPS)
        : DEZGO_SD1_DEFAULT_STEPS;
      return dezgoSd1Image2Image(prompt, references[0], output, sd1Steps);
    }
    const steps = dezgoSteps(config.env, model);
    if (isDezgoFlux(model)) return dezgoFlux(prompt, output, model, steps);
    return dezgoSd1Text2Image(prompt, output, steps);
  }
  async function gemini(prompt, references, output) {
    if (!config.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing'); const model = config.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
    const { imageSize, aspectRatio } = output.resolved.providerSettings;
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.env.GEMINI_API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: textProviders.geminiParts(prompt, references) }], generationConfig: { temperature: 0.7, responseModalities: ['TEXT','IMAGE'], imageConfig: { imageSize, aspectRatio } } }), signal: signal(config.env.IMAGE_PROVIDER_TIMEOUT_MS || 180_000, getCancellation) });
    if (!response.ok) await throwResponse('gemini', response); const data = await response.json(); const part = (data.candidates?.[0]?.content?.parts || []).find((item) => item.inlineData?.data || item.inline_data?.data); const b64 = part?.inlineData?.data || part?.inline_data?.data; if (!b64) throw new Error('Gemini image error: no image returned'); const mimeType = part?.inlineData?.mimeType || part?.inline_data?.mime_type || 'image/png'; const rawUsage = data.usageMetadata || null; const outputImageTokens = (rawUsage?.candidatesTokensDetails || []).filter((item) => item.modality === 'IMAGE').reduce((sum, item) => sum + (item.tokenCount || 0), 0); const candidateTokens = rawUsage?.candidatesTokenCount || 0; return providerResult({ output: { buffer: Buffer.from(b64, 'base64'), mimeType, extension: mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png' }, provider: 'gemini', model: data.modelVersion || model, providerRequestId: providerRequestId(response, data), settings: { output, temperature: 0.7, responseModalities: ['TEXT', 'IMAGE'] }, usage: { images: 1, ...estimatedUsage(output), ...(rawUsage ? { inputTokens: rawUsage.promptTokenCount || 0, cachedInputTokens: rawUsage.cachedContentTokenCount || 0, outputTokens: candidateTokens + (rawUsage.thoughtsTokenCount || 0), candidateTokens, outputImageTokens, outputTextOrThinkingTokens: Math.max(0, candidateTokens - outputImageTokens) + (rawUsage.thoughtsTokenCount || 0), thinkingTokens: rawUsage.thoughtsTokenCount || 0, totalTokens: rawUsage.totalTokenCount || 0, serviceTier: rawUsage.serviceTier || 'standard' } : {}) }, rawUsage, measurementStatus: rawUsage ? 'observed' : 'estimated' });
  }
  function generate({ provider, prompt, references = [], referenceBindings = [], title, output }) {
    const capabilities = imageProviderCapabilities(provider);
    if (references.length > capabilities.maxReferences) throw new RangeError(`${provider} accepts at most ${capabilities.maxReferences} planned reference image${capabilities.maxReferences === 1 ? '' : 's'}`);
    if (!output?.requested || !output?.resolved) throw new AppError('MEDIA_OUTPUT_NOT_RESOLVED', 'Image generation requires server-resolved media output', { status: 500 });
    const models = { stub: 'stub-image-v1', openai: config.env.OPENAI_IMAGE_MODEL || 'gpt-image-1', dezgo: dezgoModel(config.env), gemini: config.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image' };
    const operation = () => provider === 'stub'
      ? Promise.resolve(providerResult({ output: { buffer: stubImage(prompt, title, output.resolved), mimeType: 'image/svg+xml', extension: 'svg' }, provider: 'stub', model: models.stub, settings: { output, renderer: 'stub-svg-v1' }, usage: { images: 1, ...estimatedUsage(output) }, measurementStatus: 'not_applicable' }))
      : provider === 'openai' ? openai(prompt, references, output) : provider === 'dezgo' ? dezgo(prompt, references, output) : gemini(prompt, referenceBindings.length ? referenceBindings : references, output);
    const reservationUsage = { images: 1, ...estimatedUsage(output), ...(provider === 'dezgo' ? { steps: dezgoSteps(config.env, models.dezgo) } : {}) };
    const tracked = () => usageTracker ? usageTracker.execute({ modality: 'image', provider, model: models[provider], estimatedUsage: reservationUsage, estimatedUsageComplete: provider !== 'stub', inputMetadata: { promptCharacters: String(prompt).length, referenceCount: references.length, output } }, operation) : operation();
    return provider !== 'stub' && providerAdmission
      ? providerAdmission.run(provider, tracked, { signal: getCancellation?.() })
      : tracked();
  }
  return { capabilities: IMAGE_PROVIDER_CAPABILITIES, generate, getCapabilities: imageProviderCapabilities };
}
module.exports = { createImageProviders };
