const test = require('node:test');
const assert = require('node:assert/strict');
const { ProviderAdmissionQueue } = require('../src/services/provider-admission-queue');

test('provider admission serializes each provider FIFO while allowing independent providers to proceed', async () => {
  const queue = new ProviderAdmissionQueue({ defaultMinIntervalMs: 0 });
  const events = [];
  let releaseFirst;
  const first = queue.run('gemini', async () => { events.push('gemini:first:start'); await new Promise((resolve) => { releaseFirst = resolve; }); events.push('gemini:first:end'); });
  const second = queue.run('gemini', async () => { events.push('gemini:second'); });
  const openai = queue.run('openai', async () => { events.push('openai'); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['gemini:first:start', 'openai']);
  releaseFirst();
  await Promise.all([first, second, openai]);
  assert.deepEqual(events, ['gemini:first:start', 'openai', 'gemini:first:end', 'gemini:second']);
});

test('provider admission cancels work while it is waiting and never invokes it', async () => {
  const queue = new ProviderAdmissionQueue({ defaultMinIntervalMs: 0 });
  let release;
  const active = queue.run('openai', () => new Promise((resolve) => { release = resolve; }));
  const controller = new AbortController();
  let invoked = false;
  const waiting = queue.run('openai', async () => { invoked = true; }, { signal: controller.signal });
  controller.abort(new Error('cancelled'));
  await assert.rejects(waiting, /cancelled/);
  release();
  await active;
  assert.equal(invoked, false);
});

test('provider admission declares asynchronous lifecycle lanes centrally', () => {
  const queue = new ProviderAdmissionQueue({ defaultMinIntervalMs: 0 });
  assert.equal(queue.serializesLifecycle('minimax'), true);
  assert.equal(queue.serializesLifecycle('veo'), true);
  assert.equal(queue.serializesLifecycle('gemini'), false);
});

test('provider admission enforces configurable spacing between starts on the same API lane', async () => {
  const queue = new ProviderAdmissionQueue({ env: { PROVIDER_REQUEST_MIN_INTERVAL_MS: '15', GEMINI_REQUEST_MIN_INTERVAL_MS: '25' } });
  const starts = [];
  await Promise.all([
    queue.run('gemini', async () => starts.push(Date.now())),
    queue.run('gemini', async () => starts.push(Date.now())),
  ]);
  assert.ok(starts[1] - starts[0] >= 20, `expected provider start spacing, got ${starts[1] - starts[0]}ms`);
  assert.equal(queue.policy('gemini').minIntervalMs, 25);
  assert.equal(queue.policy('openai').minIntervalMs, 15);
});
