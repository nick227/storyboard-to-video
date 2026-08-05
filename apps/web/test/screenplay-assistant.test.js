const test = require('node:test');
const assert = require('node:assert/strict');
const { createScreenplayAssistantService } = require('../src/services/screenplay-assistant.service');

test('chat: stub mode returns a placeholder reply without calling the provider', async () => {
  const service = createScreenplayAssistantService({ textProviders: { call() { throw new Error('should not be called'); } } });
  const result = await service.chat({ scriptText: 'INT. ROOM - DAY', messages: [], userMessage: 'What happens next?', provider: 'stub' });
  assert.equal(result.usedFallback, true);
  assert.match(result.reply, /unavailable/i);
});

test('chat: sends the script tail, prior turns, and the new message to the provider', async () => {
  let request;
  const service = createScreenplayAssistantService({ textProviders: { call: async (_provider, value) => { request = value; return JSON.stringify({ reply: 'Try raising the stakes here.' }); } } });
  const result = await service.chat({
    scriptText: 'INT. COFFEE SHOP - DAY\nMARCUS enters.',
    messages: [{ role: 'user', content: 'Is this scene working?' }, { role: 'assistant', content: 'It reads a bit flat.' }],
    userMessage: 'How can I improve it?',
    provider: 'gemini',
    fallbackPolicy: 'fail',
  });
  assert.match(request, /INT\. COFFEE SHOP - DAY/);
  assert.match(request, /Is this scene working\?/);
  assert.match(request, /It reads a bit flat\./);
  assert.match(request, /How can I improve it\?/);
  assert.equal(result.reply, 'Try raising the stakes here.');
  assert.equal(result.usedFallback, false);
});

test('chat: fallbackPolicy local returns a placeholder reply on provider failure', async () => {
  const service = createScreenplayAssistantService({ textProviders: { call: async () => { throw new Error('provider down'); } } });
  const result = await service.chat({ scriptText: '', messages: [], userMessage: 'hi', provider: 'gemini', fallbackPolicy: 'local' });
  assert.equal(result.usedFallback, true);
  assert.match(result.reply, /temporarily unavailable/i);
  assert.match(result.warning, /provider down/);
});

test('chat: fallbackPolicy fail rethrows a 502 AppError on provider failure', async () => {
  const service = createScreenplayAssistantService({ textProviders: { call: async () => { throw new Error('provider down'); } } });
  await assert.rejects(
    () => service.chat({ scriptText: '', messages: [], userMessage: 'hi', provider: 'gemini', fallbackPolicy: 'fail' }),
    (error) => { assert.equal(error.code, 'INVALID_PROVIDER_RESPONSE'); assert.equal(error.statusCode, 502); return true; },
  );
});

test('chat: an empty reply from the provider is treated as a failure, not a silent success', async () => {
  const service = createScreenplayAssistantService({ textProviders: { call: async () => JSON.stringify({ reply: '   ' }) } });
  const result = await service.chat({ scriptText: '', messages: [], userMessage: 'hi', provider: 'gemini', fallbackPolicy: 'local' });
  assert.equal(result.usedFallback, true);
});

test('addNextLines: stub mode returns no continuation without calling the provider', async () => {
  const service = createScreenplayAssistantService({ textProviders: { call() { throw new Error('should not be called'); } } });
  const result = await service.addNextLines({ scriptText: 'INT. ROOM - DAY', lineCount: 10, provider: 'stub' });
  assert.equal(result.usedFallback, true);
  assert.equal(result.addedText, '');
});

test('addNextLines: sends only the script tail and the requested line count, and returns the generated text', async () => {
  let request;
  const service = createScreenplayAssistantService({ textProviders: { call: async (_provider, value) => { request = value; return JSON.stringify({ addedText: 'MARCUS\nWe should go.' }); } } });
  const scriptText = `INT. OLD START - DAY\n${'Padding line. '.repeat(2000)}\nINT. COFFEE SHOP - DAY\nMARCUS enters.`;
  const result = await service.addNextLines({ scriptText, lineCount: 10, provider: 'gemini', fallbackPolicy: 'fail' });
  assert.match(request, /INT\. COFFEE SHOP - DAY/);
  assert.doesNotMatch(request, /INT\. OLD START - DAY/);
  assert.match(request, /approximately 10 lines/);
  assert.equal(result.addedText, 'MARCUS\nWe should go.');
  assert.equal(result.usedFallback, false);
});

test('addNextLines: fallbackPolicy local returns an empty continuation on provider failure', async () => {
  const service = createScreenplayAssistantService({ textProviders: { call: async () => { throw new Error('provider down'); } } });
  const result = await service.addNextLines({ scriptText: '', lineCount: 10, provider: 'gemini', fallbackPolicy: 'local' });
  assert.equal(result.usedFallback, true);
  assert.equal(result.addedText, '');
  assert.match(result.warning, /provider down/);
});

test('addNextLines: fallbackPolicy fail rethrows a 502 AppError on an empty provider response', async () => {
  const service = createScreenplayAssistantService({ textProviders: { call: async () => JSON.stringify({ addedText: '' }) } });
  await assert.rejects(
    () => service.addNextLines({ scriptText: '', lineCount: 10, provider: 'gemini', fallbackPolicy: 'fail' }),
    (error) => { assert.equal(error.code, 'INVALID_PROVIDER_RESPONSE'); assert.equal(error.statusCode, 502); return true; },
  );
});
