const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const controllerPromise = import(path.join(__dirname, '..', 'public', 'js', 'studio', 'storyboard-controller.js'));

test('ZIP summary counts active storyboard assets and enforces the 200-shot export limit', async () => {
  const { getZipSummary } = await controllerPromise;
  const scenes = Array.from({ length: 201 }, (_, index) => ({
    versions: index === 0 ? [{ path: '/image.png' }] : [],
    videoVersions: index === 1 ? [{ path: '/video.mp4' }] : [],
    audioVersions: index === 2 ? [{ path: '/audio.mp3' }] : [],
  }));

  assert.deepEqual(getZipSummary(scenes), {
    totalScenes: 201,
    exportedScenes: 200,
    imageCount: 1,
    videoCount: 1,
    audioCount: 1,
  });
});

test('storyboard controller reports missing required controls explicitly', async () => {
  const { initStoryboardController } = await controllerPromise;
  assert.throws(
    () => initStoryboardController({}),
    /Storyboard controller is missing required DOM bindings:.*title.*downloadBullets/,
  );
});

test('storyboard stage swipe leaves scene-card buttons clickable', async () => {
  const { enableStageSwipe } = await import(path.join(__dirname, '..', 'public', 'js', 'studio', 'storyboard-gestures.js'));
  const listeners = {};
  let capturedPointer = null;
  const element = {
    dataset: {},
    classList: { add() {}, remove() {} },
    addEventListener(type, handler) { listeners[type] = handler; },
    removeEventListener() {},
    setPointerCapture(pointerId) { capturedPointer = pointerId; },
  };
  const buttonTarget = {
    closest(selector) {
      return selector === 'button,a[href]' ? this : null;
    },
  };

  enableStageSwipe(element);
  listeners.pointerdown({
    pointerType: 'mouse',
    button: 0,
    pointerId: 7,
    clientX: 10,
    clientY: 10,
    target: buttonTarget,
  });

  assert.equal(capturedPointer, null);
});

test('filmstrip drag-scroll defers pointer capture until move so thumbs stay clickable', async () => {
  const { enableDragScroll } = await import(path.join(__dirname, '..', 'public', 'js', 'studio', 'storyboard-gestures.js'));
  const listeners = {};
  let capturedPointer = null;
  const element = {
    dataset: {},
    classList: { add() {}, remove() {} },
    scrollLeft: 0,
    scrollTop: 0,
    addEventListener(type, handler) { listeners[type] = handler; },
    removeEventListener() {},
    setPointerCapture(pointerId) { capturedPointer = pointerId; },
    releasePointerCapture() { capturedPointer = null; },
  };
  const thumbTarget = {
    closest() { return null; },
  };

  enableDragScroll(element, { axis: 'x' });
  listeners.pointerdown({
    pointerType: 'mouse',
    button: 0,
    pointerId: 3,
    clientX: 40,
    clientY: 20,
    target: thumbTarget,
  });
  assert.equal(capturedPointer, null, 'click without drag must not capture (retargets click away from thumb)');

  listeners.pointermove({
    pointerId: 3,
    clientX: 52,
    clientY: 20,
    cancelable: true,
    preventDefault() {},
  });
  assert.equal(capturedPointer, 3, 'capture starts only after the drag threshold');
});
