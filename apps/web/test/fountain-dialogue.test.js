const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFountainDialogue } = require('../src/shared/fountain-dialogue');

test('parseFountainDialogue extracts standard speakers and dialogue lines', () => {
  const script = `INT. ROOM - DAY\n\nJOHN\nHello there.\nHow are you doing today?`;
  const entries = parseFountainDialogue(script);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].character, 'JOHN');
  assert.equal(entries[0].rawSpeaker, 'JOHN');
  assert.equal(entries[0].modifier, null);
  assert.equal(entries[0].isDualDialogue, false);
  assert.deepEqual(entries[0].lines, ['Hello there.', 'How are you doing today?']);
  assert.equal(entries[0].text, 'Hello there. How are you doing today?');
});

test('parseFountainDialogue parses character extensions (V.O., O.S., CONT\'D)', () => {
  const script = `SARAH (V.O.)\nI remembered the first day.\n\nMARCUS (O.S.)\nAre you still there?\n\nSARAH (CONT'D)\nYes, I am.`;
  const entries = parseFountainDialogue(script);

  assert.equal(entries.length, 3);

  assert.equal(entries[0].character, 'SARAH');
  assert.equal(entries[0].rawSpeaker, 'SARAH (V.O.)');
  assert.equal(entries[0].modifier, 'V.O.');
  assert.equal(entries[0].isVoiceOver, true);

  assert.equal(entries[1].character, 'MARCUS');
  assert.equal(entries[1].rawSpeaker, 'MARCUS (O.S.)');
  assert.equal(entries[1].modifier, 'O.S.');
  assert.equal(entries[1].isOffScreen, true);

  assert.equal(entries[2].character, 'SARAH');
  assert.equal(entries[2].rawSpeaker, 'SARAH (CONT\'D)');
  assert.equal(entries[2].modifier, "CONT'D");
});

test('parseFountainDialogue handles forced character syntax (@Name)', () => {
  const script = `@McFly\nLook at this gadget.`;
  const entries = parseFountainDialogue(script);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].character, 'McFly');
  assert.equal(entries[0].rawSpeaker, '@McFly');
  assert.equal(entries[0].text, 'Look at this gadget.');
});

test('parseFountainDialogue extracts parentheticals within dialogue blocks', () => {
  const script = `JOHN\n(whispering)\nBe quiet.\n(grinning)\nThey might hear us.`;
  const entries = parseFountainDialogue(script);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].character, 'JOHN');
  assert.deepEqual(entries[0].parentheticals, ['whispering', 'grinning']);
  assert.equal(entries[0].text, 'Be quiet. They might hear us.');
});

test('parseFountainDialogue detects dual dialogue markers (^)', () => {
  const script = `JOHN ^\nWe should leave now.`;
  const entries = parseFountainDialogue(script);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].character, 'JOHN');
  assert.equal(entries[0].isDualDialogue, true);
});

test('parseFountainDialogue handles action interruptions and multiple character exchanges', () => {
  const script = `INT. LAB - NIGHT\n\nDR. ARIS\nThe experiment is complete.\n\nHe presses a red button on the control panel.\n\nASSISTANT\nDid it work?\n\nDR. ARIS\nSee for yourself.`;
  const entries = parseFountainDialogue(script);

  assert.equal(entries.length, 3);
  assert.equal(entries[0].character, 'DR. ARIS');
  assert.equal(entries[0].text, 'The experiment is complete.');

  assert.equal(entries[1].character, 'ASSISTANT');
  assert.equal(entries[1].text, 'Did it work?');

  assert.equal(entries[2].character, 'DR. ARIS');
  assert.equal(entries[2].text, 'See for yourself.');
});

test('parseFountainDialogue returns empty array gracefully for non-Fountain plain prose', () => {
  const script = `The hero walked down the dark street. Nothing stirred in the shadows.`;
  const entries = parseFountainDialogue(script);

  assert.deepEqual(entries, []);
});
