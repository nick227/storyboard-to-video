const test = require('node:test');
const assert = require('node:assert/strict');
const { createImageProviders } = require('../src/providers/image');
const { mergeMediaIntent, resolveImageOutput } = require('../src/shared/media-output-policy');

test('Gemini image provider error extraction', async () => {
  const originalFetch = global.fetch;
  let responseData = {};
  
  global.fetch = async () => {
    return new Response(JSON.stringify(responseData), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  const providers = createImageProviders(
    { env: { GEMINI_API_KEY: 'mock-key' } },
    { geminiParts: () => [] }
  );
  
  const intent = mergeMediaIntent({ modality: 'image' });
  const output = resolveImageOutput({ provider: 'gemini', model: 'gemini-3.1-flash-image', intent });

  try {
    // Case 1: Prompt Blocked
    responseData = {
      promptFeedback: { blockReason: 'SAFETY' }
    };
    await assert.rejects(
      () => providers.generate({ provider: 'gemini', prompt: 'Prompt', references: [], output }),
      /Gemini image error: no image returned \(prompt blocked: SAFETY\)/
    );

    // Case 2: Candidate Generation Stopped
    responseData = {
      candidates: [{ finishReason: 'SAFETY' }]
    };
    await assert.rejects(
      () => providers.generate({ provider: 'gemini', prompt: 'Prompt', references: [], output }),
      /Gemini image error: no image returned \(generation stopped: SAFETY\)/
    );

    // Case 3: API Error Message
    responseData = {
      error: { message: 'Quota exceeded or invalid request' }
    };
    await assert.rejects(
      () => providers.generate({ provider: 'gemini', prompt: 'Prompt', references: [], output }),
      /Gemini image error: no image returned \(Quota exceeded or invalid request\)/
    );

    // Case 4: Default No Image
    responseData = {};
    await assert.rejects(
      () => providers.generate({ provider: 'gemini', prompt: 'Prompt', references: [], output }),
      /^Error: Gemini image error: no image returned$/
    );
  } finally {
    global.fetch = originalFetch;
  }
});
