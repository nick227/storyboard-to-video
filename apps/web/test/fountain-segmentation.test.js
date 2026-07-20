const test = require('node:test');
const assert = require('node:assert/strict');
const { splitIntoFragments, fallbackSceneFromFragment, splitSceneIntoScenes } = require('../src/shared/segmentation');

test('non-Fountain prose: splits by lines when line count satisfies requested count', () => {
  const text = 'First prose paragraph.\nSecond prose paragraph.\nThird prose paragraph.';
  const fragments = splitIntoFragments(text, 3);

  assert.equal(fragments.length, 3);
  assert.equal(fragments[0].scriptFragment, 'First prose paragraph.');
  assert.equal(fragments[1].scriptFragment, 'Second prose paragraph.');
  assert.equal(fragments[2].scriptFragment, 'Third prose paragraph.');
});

test('non-Fountain prose: falls back to period splitting when line count is insufficient', () => {
  const text = 'First sentence here. Second sentence follows. Third sentence ends.';
  const fragments = splitIntoFragments(text, 3);

  assert.equal(fragments.length, 3);
  assert.equal(fragments[0].scriptFragment, 'First sentence here.');
  assert.equal(fragments[1].scriptFragment, 'Second sentence follows.');
  assert.equal(fragments[2].scriptFragment, 'Third sentence ends.');
});

test('Fountain script: groups scene headings with following action/dialogue into cohesive scene fragments', () => {
  const script = `INT. COFFEE SHOP - DAY

MARCUS
Still using that ancient machine?

EXT. STREET - NIGHT

SARAH
It has soul. No notifications.

SARAH walks into the rain.`;

  const fragments = splitIntoFragments(script, 2);

  assert.equal(fragments.length, 2);
  assert.match(fragments[0].scriptFragment, /^INT\. COFFEE SHOP - DAY/);
  assert.match(fragments[0].scriptFragment, /MARCUS/);
  assert.match(fragments[0].scriptFragment, /ancient machine\?/);

  assert.match(fragments[1].scriptFragment, /^EXT\. STREET - NIGHT/);
  assert.match(fragments[1].scriptFragment, /SARAH/);
  assert.match(fragments[1].scriptFragment, /walks into the rain\./);
});

test('Fountain script: distributes multiple scene headings across requested scene count accurately', () => {
  const script = `INT. LAB - DAY
Dr. Aris turns on the screen.

EXT. ROOFTOP - NIGHT
Rain falls heavily.

INT. BASEMENT - NIGHT
The alarm sounds.`;

  const fragments = splitIntoFragments(script, 3);

  assert.equal(fragments.length, 3);
  assert.match(fragments[0].scriptFragment, /^INT\. LAB - DAY/);
  assert.match(fragments[1].scriptFragment, /^EXT\. ROOFTOP - NIGHT/);
  assert.match(fragments[2].scriptFragment, /^INT\. BASEMENT - NIGHT/);
});
