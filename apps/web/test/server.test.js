const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const {
  buildScenePrompts,
  buildSceneDialogue,
  buildWavBuffer,
  clampSceneCount,
  concatenatePcmLines,
  createProviderError,
  getAdditionalCommonPrompt,
  regenerateSinglePrompt,
  resolveAudioAsset,
  resolveGeneratedAsset,
  splitIntoScenes,
} = require('../server');

test('scene count is clamped to the supported range', () => {
  assert.equal(clampSceneCount(0), 1);
  assert.equal(clampSceneCount(500), 50);
  assert.equal(clampSceneCount('not-a-number'), 6);
});

test('scene count suggestion scales with story length and screenplay structure', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/modules/scene-count.js'), 'utf8');
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const { suggestSceneCount } = await import(moduleUrl);

  assert.equal(suggestSceneCount(''), 1);
  assert.equal(suggestSceneCount('A hero opens the door.'), 1);
  assert.ok(suggestSceneCount(Array.from({ length: 400 }, () => 'word').join(' ')) >= 10);
  assert.equal(suggestSceneCount('INT. KITCHEN - DAY\nA door opens.\n\nEXT. STREET - NIGHT\nA car stops.'), 2);
  assert.equal(suggestSceneCount(Array.from({ length: 3000 }, () => 'word').join(' ')), 50);
});

test('fallback scene splitting covers the entire story', () => {
  const sentences = Array.from({ length: 12 }, (_, index) => `Beat ${index + 1}.`);
  const scenes = splitIntoScenes(sentences.join(' '), 3);
  assert.equal(scenes.length, 3);
  assert.match(scenes[0].beat, /Beat 1/);
  assert.match(scenes[2].beat, /Beat 12/);
});

test('fallback scene splitting returns the requested count for short text', () => {
  const scenes = splitIntoScenes('One concise story beat with enough words to divide across scenes.', 4);
  assert.equal(scenes.length, 4);
  assert.ok(scenes.every((scene) => scene.beat.length > 0));
});

test('generated asset resolution rejects path traversal and unrelated paths', () => {
  assert.equal(resolveGeneratedAsset('../../.env'), null);
  assert.equal(resolveGeneratedAsset('/generated/../../.env'), null);
  assert.equal(resolveGeneratedAsset('/generated/%2e%2e%2f.env'), null);
  assert.equal(resolveGeneratedAsset('/not-generated/image.png'), null);
});

test('generated asset resolution accepts a generated basename', () => {
  const asset = resolveGeneratedAsset('/generated/01-opening-123.png');
  assert.equal(asset.fileName, '01-opening-123.png');
  assert.equal(path.basename(asset.sourcePath), asset.fileName);
});

test('provider quota errors remain HTTP 429 and give actionable guidance', () => {
  const error = createProviderError('gemini', 429, 'RESOURCE_EXHAUSTED', '10');
  assert.equal(error.statusCode, 429);
  assert.equal(error.retryAfter, '10');
  assert.match(error.message, /quota exceeded/i);
  assert.match(error.message, /another provider/i);
});

test('a style-prefilled common prompt is not duplicated in provider prompts', () => {
  const style = 'Bold ink lines and flat color.';
  assert.equal(getAdditionalCommonPrompt(style, style), '');
  assert.equal(getAdditionalCommonPrompt(style, `${style}\nKeep faces consistent.`), 'Keep faces consistent.');
});

test('stub text mode uses local fallback prompts without calling remote providers', async () => {
  const style = { id: 'basic-cartoon', promptText: 'A playful comic style' };
  const result = await buildScenePrompts({
    scriptText: 'A hero enters a strange town.',
    sceneCount: 2,
    style,
    commonPromptText: '',
    provider: 'stub',
  });

  assert.equal(result.usedFallback, true);
  assert.equal(result.scenes.length, 2);
  assert.match(result.warning, /stub/i);
  assert.match(result.scenes[0].prompt, /Clear subject, key pose/i);
});

test('buildWavBuffer writes a correct RIFF/WAVE header for the given PCM data', () => {
  const pcm = Buffer.alloc(400);
  const wav = buildWavBuffer(pcm, { sampleRate: 24000, channels: 1, bitsPerSample: 16 });
  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length);
});

test('concatenatePcmLines joins buffers with a silence gap between each line', () => {
  const a = Buffer.alloc(100, 1);
  const b = Buffer.alloc(200, 2);
  const c = Buffer.alloc(50, 3);
  const combined = concatenatePcmLines([a, b, c], { gapMs: 10 });
  const gapBytes = Math.round((10 / 1000) * 24000) * 2;
  assert.equal(combined.length, a.length + b.length + c.length + gapBytes * 2);
});

test('resolveAudioAsset rejects path traversal and unrelated paths', () => {
  assert.equal(resolveAudioAsset('../../.env'), null);
  assert.equal(resolveAudioAsset('/audio/../../.env'), null);
  assert.equal(resolveAudioAsset('/audio/%2e%2e%2f.env'), null);
  assert.equal(resolveAudioAsset('/not-audio/clip.wav'), null);
  assert.equal(resolveAudioAsset('/generated/image.png'), null);
});

test('resolveAudioAsset accepts an audio basename', () => {
  const asset = resolveAudioAsset('/audio/01-opening-123.wav');
  assert.equal(asset.fileName, '01-opening-123.wav');
  assert.equal(path.basename(asset.sourcePath), asset.fileName);
});

test('stub dialogue mode produces fallback narration without calling a remote provider', async () => {
  const scenes = [
    { sceneNumber: 1, title: 'Scene 1', beat: 'A hero enters a town.' },
    { sceneNumber: 2, title: 'Scene 2', beat: 'The hero meets a stranger.' },
  ];
  const result = await buildSceneDialogue({ scenes, provider: 'stub' });

  assert.equal(result.usedFallback, true);
  assert.equal(result.scenesDialogue.length, 2);
  assert.match(result.warning, /stub/i);
  assert.match(result.scenesDialogue[0].narrationText, /hero enters a town/i);
});

test('stub prompt regeneration keeps a usable prompt without a remote provider', async () => {
  const style = { id: 'basic-cartoon', promptText: 'A playful comic style' };
  const result = await regenerateSinglePrompt({
    scriptText: 'A hero enters a strange town.',
    scene: { title: 'Scene 1', beat: 'A hero enters a town.', prompt: 'A hero stands in a town.' },
    sceneIndex: 0,
    style,
    commonPromptText: '',
    provider: 'stub',
    extraPromptText: '',
  });

  assert.equal(result.usedFallback, true);
  assert.match(result.warning, /stub/i);
  assert.match(result.prompt, /hero/i);
});
