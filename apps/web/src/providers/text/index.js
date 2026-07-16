const fs = require('node:fs');
const path = require('node:path');
const { signal, throwResponse } = require('../http');

function mime(file) { const ext = path.extname(file).toLowerCase(); return ['.jpg', '.jpeg'].includes(ext) ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/png'; }
function geminiParts(prompt, references) { const parts = [{ text: prompt }]; for (const file of references) if (fs.existsSync(file)) parts.push({ text: 'Reference image' }, { inline_data: { mime_type: mime(file), data: fs.readFileSync(file).toString('base64') } }); return parts; }
function createTextProviders(config, getCancellation) {
  async function openai(prompt) {
    if (!config.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
    const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.env.OPENAI_API_KEY}` }, body: JSON.stringify({ model: config.env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini', input: prompt }), signal: signal(config.env.TEXT_PROVIDER_TIMEOUT_MS || 60_000, getCancellation) });
    if (!response.ok) await throwResponse('openai', response); return (await response.json()).output_text || '';
  }
  async function gemini(prompt, references = []) {
    if (!config.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing');
    const model = config.env.GEMINI_TEXT_MODEL || 'gemini-3.5-flash'; const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.env.GEMINI_API_KEY}`;
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: geminiParts(prompt, references) }], generationConfig: { temperature: 0.7, responseMimeType: 'application/json' } }), signal: signal(config.env.TEXT_PROVIDER_TIMEOUT_MS || 60_000, getCancellation) });
    if (!response.ok) await throwResponse('gemini', response); const data = await response.json(); return data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('\n') || '';
  }
  return { call: (provider, prompt, references) => provider === 'openai' ? openai(prompt) : gemini(prompt, references), geminiParts };
}
module.exports = { createTextProviders };
