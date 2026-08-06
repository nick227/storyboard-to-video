const test = require('node:test');
const assert = require('node:assert/strict');
const { createScreenplayAssistantService, normalizeFountainContinuation } = require('../src/services/screenplay-assistant.service');

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

test('chat: includes story summary in the provider prompt when present', async () => {
  let request;
  const service = createScreenplayAssistantService({ textProviders: { call: async (_provider, value) => { request = value; return JSON.stringify({ reply: 'Lean on the summary stakes.' }); } } });
  const result = await service.chat({
    scriptText: '',
    summary: 'A courier must deliver a sealed letter before dawn.',
    messages: [],
    userMessage: 'Where should I start?',
    provider: 'gemini',
    fallbackPolicy: 'fail',
  });
  assert.match(request, /Story bible \(authoritative\):/);
  assert.match(request, /sealed letter before dawn/);
  assert.match(request, /sole brief/);
  assert.match(request, /\(empty screenplay\)/);
  assert.equal(result.reply, 'Lean on the summary stakes.');
});

test('chat: windows long histories to the most recent turns', async () => {
  let request;
  const service = createScreenplayAssistantService({ textProviders: { call: async (_provider, value) => { request = value; return JSON.stringify({ reply: 'ok' }); } } });
  const messages = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `turn-${index}`,
  }));
  await service.chat({
    scriptText: 'INT. ROOM - DAY',
    messages,
    userMessage: 'latest?',
    provider: 'gemini',
    fallbackPolicy: 'fail',
  });
  assert.match(request, /earlier turn/);
  assert.doesNotMatch(request, /turn-0/);
  assert.doesNotMatch(request, /turn-7/);
  assert.match(request, /turn-8/);
  assert.match(request, /turn-19/);
  assert.match(request, /latest\?/);
});

test('addNextLines: empty script uses summary as the primary brief', async () => {
  let request;
  const service = createScreenplayAssistantService({ textProviders: { call: async (_provider, value) => { request = value; return JSON.stringify({ addedText: 'INT. ALLEY - NIGHT\n\nRain sheets down.' }); } } });
  const result = await service.addNextLines({
    scriptText: '',
    summary: 'A courier must deliver a sealed letter before dawn.',
    lineCount: 8,
    provider: 'gemini',
    fallbackPolicy: 'fail',
  });
  assert.match(request, /Story bible \(authoritative\):/);
  assert.match(request, /primary brief/);
  assert.match(request, /sealed letter before dawn/);
  assert.match(result.addedText, /INT\. ALLEY - NIGHT/);
});

test('addNextLines: mid-script continuation keeps summary as arc authority', async () => {
  let request;
  const service = createScreenplayAssistantService({ textProviders: { call: async (_provider, value) => { request = value; return JSON.stringify({ addedText: 'MARCUS\nWe keep moving.' }); } } });
  await service.addNextLines({
    scriptText: 'INT. ALLEY - NIGHT\n\nMARCUS runs.',
    summary: 'A courier must deliver a sealed letter before dawn.',
    lineCount: 6,
    provider: 'gemini',
    fallbackPolicy: 'fail',
  });
  assert.match(request, /Story bible \(authoritative\):/);
  assert.match(request, /next unresolved beat/);
  assert.match(request, /do not contradict/);
});

test('addNextLines: truncated tails are marked as omitted earlier content', async () => {
  let request;
  const service = createScreenplayAssistantService({ textProviders: { call: async (_provider, value) => { request = value; return JSON.stringify({ addedText: 'MARCUS\nWe should go.' }); } } });
  const scriptText = `INT. OLD START - DAY\n${'Padding line. '.repeat(2000)}\nINT. COFFEE SHOP - DAY\nMARCUS enters.`;
  await service.addNextLines({ scriptText, lineCount: 10, provider: 'gemini', fallbackPolicy: 'fail' });
  assert.match(request, /Earlier screenplay content omitted/);
  assert.match(request, /INT\. COFFEE SHOP - DAY/);
  assert.doesNotMatch(request, /INT\. OLD START - DAY/);
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
  assert.match(request, /approximately 10 printed lines/);
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

test('addNextLines: normalizes the provider output before returning it', async () => {
  const service = createScreenplayAssistantService({ textProviders: { call: async () => JSON.stringify({ addedText: 'MARCUS\nHello there.\nSARAH\nHi Marcus.' }) } });
  const result = await service.addNextLines({ scriptText: '', lineCount: 10, provider: 'gemini', fallbackPolicy: 'fail' });
  assert.equal(result.addedText, 'MARCUS\nHello there.\n\nSARAH\nHi Marcus.');
});

test('normalizeFountainContinuation: inserts a blank line between one character\'s dialogue and the next character\'s cue', () => {
  // Without the blank line, this app's own Fountain classifier (FountainAdapter.js) demotes SARAH
  // to an ACTION line instead of recognizing it as a new character cue -- merging both characters'
  // lines together. This is the actual corruption risk, not the reverse.
  const result = normalizeFountainContinuation('MARCUS\nHello there.\nSARAH\nHi Marcus.');
  assert.equal(result, 'MARCUS\nHello there.\n\nSARAH\nHi Marcus.');
});

test('normalizeFountainContinuation: uppercases a lowercase scene heading and separates it from surrounding lines', () => {
  const result = normalizeFountainContinuation('Marcus enters.\nint. office - day\nHe sits.');
  assert.equal(result, 'Marcus enters.\n\nINT. OFFICE - DAY\nHe sits.');
});

test('normalizeFountainContinuation: inserts a blank line between a dialogue block and the following action', () => {
  const result = normalizeFountainContinuation('MARCUS\nHello there.\nHe walks away.');
  assert.equal(result, 'MARCUS\nHello there.\n\nHe walks away.');
});

test('normalizeFountainContinuation: never inserts a blank line between a character cue and its own dialogue or parenthetical', () => {
  // A blank line here would be actively harmful -- the classifier requires dialogue/parentheticals
  // to stay adjacent to their character cue to be recognized as belonging to it.
  const result = normalizeFountainContinuation('MARCUS\n(smiling)\nHello there.');
  assert.equal(result, 'MARCUS\n(smiling)\nHello there.');
});

test('normalizeFountainContinuation: uppercases transitions and leaves well-formed text unchanged (idempotent)', () => {
  const wellFormed = 'INT. COFFEE SHOP - DAY\n\nMARCUS enters.\n\nMARCUS\nHello.\n\nSARAH\nHi.';
  assert.equal(normalizeFountainContinuation(wellFormed), wellFormed);
  assert.equal(normalizeFountainContinuation('Marcus leaves.\ncut to:\nEXT. STREET - DAY'), 'Marcus leaves.\n\nCUT TO:\n\nEXT. STREET - DAY');
});
