// Exercises the pure word-window-picking logic in public/modules/subtitle-overlay.js directly via
// dynamic import -- see frontend-stages.test.js for why this works under plain Node.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const overlayPromise = import(path.join(__dirname, '..', 'public', 'modules', 'subtitle-overlay.js'));

function words() {
  return [
    { text: 'Hello', start: 0, end: 0.3 },
    { text: 'there,', start: 0.35, end: 0.6 },
    { text: 'friend.', start: 0.65, end: 1.0 },
    { text: 'Nice', start: 3.0, end: 3.2 },
    { text: 'day.', start: 3.25, end: 3.5 },
  ];
}

test('pickCaptionWindow returns null for no words', async () => {
  const { pickCaptionWindow } = await overlayPromise;
  assert.equal(pickCaptionWindow([], 0), null);
  assert.equal(pickCaptionWindow(null, 0), null);
});

test('pickCaptionWindow marks the word whose [start,end) contains currentTime as current', async () => {
  const { pickCaptionWindow } = await overlayPromise;
  const result = pickCaptionWindow(words(), 0.5);
  assert.equal(result.currentIndex, 1);
  const current = result.items.find((item) => item.isCurrent);
  assert.equal(current.text, 'there,');
});

test('pickCaptionWindow during a pause tracks the nearest already-spoken word instead of resetting to index 0', async () => {
  const { pickCaptionWindow } = await overlayPromise;
  const result = pickCaptionWindow(words(), 2.0); // between "friend." (ends 1.0) and "Nice" (starts 3.0)
  assert.equal(result.currentIndex, -1);
  assert.ok(result.items.some((item) => item.text === 'friend.'));
  assert.ok(result.items.every((item) => !item.isCurrent));
});

test('pickCaptionWindow before the first word starts centers on index 0, not a negative index', async () => {
  const { pickCaptionWindow } = await overlayPromise;
  const result = pickCaptionWindow(words(), -1);
  assert.equal(result.currentIndex, -1);
  assert.equal(result.items[0].text, 'Hello');
});

test('pickCaptionWindow after the last word stays on the last word, not the transcript start', async () => {
  const { pickCaptionWindow } = await overlayPromise;
  const result = pickCaptionWindow(words(), 10);
  assert.equal(result.currentIndex, -1);
  assert.equal(result.items[result.items.length - 1].text, 'day.');
});

test('pickCaptionWindow respects a custom radius', async () => {
  const { pickCaptionWindow } = await overlayPromise;
  const result = pickCaptionWindow(words(), 0.5, 1);
  assert.equal(result.items.length, 3); // "Hello", "there,", "friend."
});
