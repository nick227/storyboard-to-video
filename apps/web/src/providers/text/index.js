const fs = require('node:fs');
const path = require('node:path');
const { signal, throwResponse } = require('../http');
const { providerRequestId, providerResult } = require('../result');

function mime(file) { const ext = path.extname(file).toLowerCase(); return ['.jpg', '.jpeg'].includes(ext) ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/png'; }
const GEMINI_REFERENCE_INSTRUCTIONS = Object.freeze({
  character: 'CHARACTER IDENTITY. Preserve the character’s recognizable appearance, proportions, hair, face, and signature clothing; do not copy the background or pose unless requested.',
  location: 'LOCATION IDENTITY. Preserve the recognizable setting, layout, architecture, materials, and palette; the camera angle may change.',
  composition: 'COMPOSITION. Use the framing, camera angle, blocking, and pose as guidance; do not copy identity or art style unless the prompt requests it.',
  continuity: 'PREVIOUS SHOT CONTINUITY. Maintain established character appearance, wardrobe, location details, palette, and lighting while creating the new shot.',
});
function referenceFile(reference) { return typeof reference === 'string' ? reference : reference?.path; }
function geminiParts(prompt, references) {
  const parts = [{ text: prompt }];
  for (const [index, reference] of (references || []).entries()) {
    const file = referenceFile(reference);
    if (!file || !fs.existsSync(file)) continue;
    const instruction = GEMINI_REFERENCE_INSTRUCTIONS[reference?.role] || 'REFERENCE IMAGE. Use only as relevant to the prompt.';
    parts.push({ text: `REFERENCE ${index + 1} — ${instruction}` }, { inline_data: { mime_type: mime(file), data: fs.readFileSync(file).toString('base64') } });
  }
  return parts;
}
function createTextProviders(config, getCancellation, usageTracker, providerAdmission) {
  async function openai(prompt) {
    if (!config.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
    const model = config.env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini';
    const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.env.OPENAI_API_KEY}` }, body: JSON.stringify({ model, input: prompt }), signal: signal(config.env.TEXT_PROVIDER_TIMEOUT_MS || 60_000, getCancellation) });
    if (!response.ok) await throwResponse('openai', response);
    const data = await response.json(); const rawUsage = data.usage || null;
    const output = data.output_text || (data.output || []).flatMap((item) => item.content || []).map((item) => item.text || '').join('');
    return providerResult({ output, provider: 'openai', model: data.model || model, providerRequestId: providerRequestId(response, data), usage: rawUsage ? { inputTokens: rawUsage.input_tokens || 0, cachedInputTokens: rawUsage.input_tokens_details?.cached_tokens || 0, outputTokens: rawUsage.output_tokens || 0, reasoningTokens: rawUsage.output_tokens_details?.reasoning_tokens || 0, totalTokens: rawUsage.total_tokens || 0, serviceTier: data.service_tier || 'default' } : {}, rawUsage, measurementStatus: rawUsage ? 'observed' : 'unavailable' });
  }
  async function gemini(prompt, references = []) {
    if (!config.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing');
    const model = config.env.GEMINI_TEXT_MODEL || 'gemini-3.5-flash'; const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.env.GEMINI_API_KEY}`;
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: geminiParts(prompt, references) }], generationConfig: { temperature: 0.7, responseMimeType: 'application/json' } }), signal: signal(config.env.TEXT_PROVIDER_TIMEOUT_MS || 60_000, getCancellation) });
    if (!response.ok) await throwResponse('gemini', response); const data = await response.json(); const rawUsage = data.usageMetadata || null;
    return providerResult({ output: data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('\n') || '', provider: 'gemini', model: data.modelVersion || model, providerRequestId: providerRequestId(response, data), usage: rawUsage ? { inputTokens: rawUsage.promptTokenCount || 0, cachedInputTokens: rawUsage.cachedContentTokenCount || 0, outputTokens: (rawUsage.candidatesTokenCount || 0) + (rawUsage.thoughtsTokenCount || 0), candidateTokens: rawUsage.candidatesTokenCount || 0, thinkingTokens: rawUsage.thoughtsTokenCount || 0, totalTokens: rawUsage.totalTokenCount || 0, serviceTier: rawUsage.serviceTier || 'standard' } : {}, rawUsage, measurementStatus: rawUsage ? 'observed' : 'unavailable' });
  }
  function call(provider, prompt, references = []) {
    const model = provider === 'stub' ? 'stub-text-v1' : provider === 'openai' ? (config.env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini') : (config.env.GEMINI_TEXT_MODEL || 'gemini-3.5-flash');
    const operation = () => provider === 'stub'
      ? Promise.resolve(providerResult({ output: '', provider: 'stub', model, usage: { inputCharacters: String(prompt).length }, measurementStatus: 'not_applicable' }))
      : provider === 'openai' ? openai(prompt) : gemini(prompt, references);
    const tracked = () => usageTracker ? usageTracker.execute({ modality: 'text', provider, model, inputMetadata: { promptCharacters: String(prompt).length, referenceCount: references.length } }, operation) : operation();
    return provider !== 'stub' && providerAdmission
      ? providerAdmission.run(provider, tracked, { signal: getCancellation?.() })
      : tracked();
  }
  return { call, geminiParts };
}
module.exports = { GEMINI_REFERENCE_INSTRUCTIONS, createTextProviders };
