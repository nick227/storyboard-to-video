#!/usr/bin/env node
/**
 * Live smoke against Modal SDXL (IMAGE_SERVICE_URL from apps/web/.env).
 *   node scripts/smoke-image-service.js            # health + tiny generate
 *   node scripts/smoke-image-service.js --health-only
 * Skips (exit 0) when IMAGE_SERVICE_URL is unset.
 */
require('dotenv').config();

const healthOnly = process.argv.includes('--health-only');
const url = String(process.env.IMAGE_SERVICE_URL || '').replace(/\/+$/, '');
const token = String(process.env.IMAGE_SERVICE_TOKEN || '');

function authHeaders(json = false) {
  const headers = {};
  if (json) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function health() {
  const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(120_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`health HTTP ${response.status}: ${JSON.stringify(body)}`);
  if (!body.ok) throw new Error(`health not ok: ${JSON.stringify(body)}`);
  console.log(`ok: health ${url} model=${body.model} loaded=${body.loaded} cuda=${body.cuda}`);
  return body;
}

async function generate() {
  if (!token) throw new Error('IMAGE_SERVICE_TOKEN is required for /generate');
  const response = await fetch(`${url}/generate`, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({
      prompt: 'a simple red circle on a white background, flat design',
      width: 512,
      height: 512,
      steps: 12,
      guidance: 5,
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(`generate HTTP ${response.status}: ${JSON.stringify(detail)}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50) throw new Error('generate response was not a PNG');
  console.log(`ok: generate ${bytes.length} PNG bytes`);
}

async function main() {
  if (!url) {
    console.log('skip: IMAGE_SERVICE_URL unset (Modal SDXL disabled)');
    return;
  }
  try {
    await health();
  } catch (error) {
    // prestart uses --health-only; a down Modal workspace must not block local web.
    if (healthOnly) {
      console.warn(`warn: ${error.message || error} (continuing; SDXL may be unavailable)`);
      return;
    }
    throw error;
  }
  if (!healthOnly) await generate();
}

main().catch((error) => {
  console.error(`fail: ${error.message || error}`);
  process.exitCode = 1;
});
