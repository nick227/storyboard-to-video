const test = require('node:test');
const assert = require('node:assert/strict');
const { createDialogueService } = require('../src/services/dialogue.service');

test('dialogue service stub mode: uses structured dialogue for Fountain scripts', async () => {
  const service = createDialogueService({ textProviders: { call() {} } });

  const scenes = [
    {
      sceneNumber: 1,
      scriptFragment: 'INT. COFFEE SHOP - DAY\n\nMARCUS\nStill using that ancient machine?',
      beat: 'Marcus types on a vintage typewriter.',
    },
  ];

  const result = await service.generate({ scenes, provider: 'stub' });

  assert.equal(result.scenesDialogue.length, 1);
  assert.match(result.scenesDialogue[0].narrationText, /MARCUS: "Still using that ancient machine\?"/);
});

test('dialogue service stub mode: preserves fallback narration format for non-Fountain prose scripts', async () => {
  const service = createDialogueService({ textProviders: { call() {} } });

  const scenes = [
    {
      sceneNumber: 1,
      scriptFragment: 'The hero walked down the empty hallway toward the light.',
      beat: 'Hero walks down hallway.',
    },
  ];

  const result = await service.generate({ scenes, provider: 'stub' });

  assert.equal(result.scenesDialogue.length, 1);
  assert.match(result.scenesDialogue[0].narrationText, /\[Fallback Narration: Hero walks down hallway\.\]/);
});

test('dialogue service provider mode: incorporates parsed Fountain dialogue into AI prompt context', async () => {
  let capturedRequest = '';
  const service = createDialogueService({
    textProviders: {
      call: async (_provider, request) => {
        capturedRequest = request;
        return JSON.stringify({
          scenes: [{ sceneNumber: 1, narrationText: 'Marcus asks Sarah about her ancient typewriter.' }],
        });
      },
    },
  });

  const scenes = [
    {
      sceneNumber: 1,
      scriptFragment: 'INT. COFFEE SHOP - DAY\n\nMARCUS\n(smiling)\nStill using that ancient machine?',
      beat: 'Marcus smiles at Sarah.',
    },
  ];

  const result = await service.generate({ scenes, provider: 'gemini', fallbackPolicy: 'fail' });

  assert.equal(result.scenesDialogue.length, 1);
  assert.match(capturedRequest, /Extracted Dialogue/i);
  assert.match(capturedRequest, /MARCUS/);
  assert.match(capturedRequest, /Still using that ancient machine\?/);
  assert.equal(result.scenesDialogue[0].narrationText, 'Marcus asks Sarah about her ancient typewriter.');
});
