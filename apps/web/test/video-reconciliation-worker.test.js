const test = require('node:test');
const assert = require('node:assert/strict');

const { startVideoReconciliationWorker } = require('../src/workers/video-reconciliation-worker');

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test('the reconciliation worker polls reconcileAttempts on an interval, immediately on start', async () => {
  let calls = 0;
  const videos = { reconcileAttempts: async () => { calls += 1; return []; } };
  const worker = startVideoReconciliationWorker(videos, { intervalMs: 10 });
  try {
    await wait(5);
    assert.equal(calls, 1, 'the worker must reconcile once immediately on start, not only after the first interval');
    await wait(45);
    assert.ok(calls >= 3, `expected multiple reconcile passes within 50ms at a 10ms interval, got ${calls}`);
  } finally {
    worker.stop();
  }
});

test('a failing reconcile pass is reported but does not stop future polling', async () => {
  let calls = 0;
  const errors = [];
  const videos = { reconcileAttempts: async () => { calls += 1; throw new Error('provider unreachable'); } };
  const worker = startVideoReconciliationWorker(videos, { intervalMs: 10, onError: (error) => errors.push(error) });
  try {
    await wait(35);
    assert.ok(calls >= 2, `expected polling to continue after a failure, got ${calls} calls`);
    assert.ok(errors.length >= 1);
    assert.equal(errors[0].message, 'provider unreachable');
  } finally {
    worker.stop();
  }
});

test('stop() halts further polling', async () => {
  let calls = 0;
  const videos = { reconcileAttempts: async () => { calls += 1; return []; } };
  const worker = startVideoReconciliationWorker(videos, { intervalMs: 10 });
  await wait(5);
  worker.stop();
  const callsAtStop = calls;
  await wait(40);
  assert.equal(calls, callsAtStop, 'no further reconcile calls should happen after stop()');
});

test('a replica skips reconciliation when another replica owns the database lifecycle lock', async () => {
  let reconciles = 0;
  const distributedLock = { async tryRun() { return { acquired: false }; } };
  const worker = startVideoReconciliationWorker({ async reconcileAttempts() { reconciles += 1; return []; } }, { intervalMs: 10, distributedLock });
  await new Promise((resolve) => setTimeout(resolve, 25));
  worker.stop();
  assert.equal(reconciles, 0);
});
