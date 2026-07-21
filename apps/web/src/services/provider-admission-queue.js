const { AppError } = require('../errors');

const DEFAULT_PROVIDER_POLICIES = Object.freeze({
  openai: Object.freeze({}),
  gemini: Object.freeze({}),
  dezgo: Object.freeze({}),
  elevenlabs: Object.freeze({}),
  spark: Object.freeze({}),
  alignment: Object.freeze({}),
  piper: Object.freeze({}),
  ltx: Object.freeze({}),
  minimax: Object.freeze({ lifecycle: 'serial' }),
  veo: Object.freeze({ lifecycle: 'serial' }),
  stripe: Object.freeze({}),
});

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function envName(provider) { return String(provider).toUpperCase().replace(/[^A-Z0-9]+/g, '_'); }

class ProviderAdmissionQueue {
  constructor({ env = process.env, policies = DEFAULT_PROVIDER_POLICIES, defaultMinIntervalMs } = {}) {
    this.env = env;
    this.defaultMinIntervalMs = positiveInteger(defaultMinIntervalMs ?? env.PROVIDER_REQUEST_MIN_INTERVAL_MS, 1_000);
    this.policies = new Map(Object.entries(policies));
    this.lanes = new Map();
  }

  policy(provider) {
    const declared = this.policies.get(provider) || {};
    return {
      lifecycle: declared.lifecycle || 'request',
      minIntervalMs: positiveInteger(
        this.env[`${envName(provider)}_REQUEST_MIN_INTERVAL_MS`],
        positiveInteger(declared.minIntervalMs, this.defaultMinIntervalMs),
      ),
    };
  }

  serializesLifecycle(provider) { return this.policy(provider).lifecycle === 'serial'; }

  lane(provider) {
    if (!this.lanes.has(provider)) this.lanes.set(provider, { running: false, pending: [], lastStartedAt: 0 });
    return this.lanes.get(provider);
  }

  run(provider, operation, { signal, minIntervalMs } = {}) {
    if (typeof operation !== 'function') return Promise.reject(new TypeError('Provider admission requires an operation function'));
    if (signal?.aborted) return Promise.reject(signal.reason || new AppError('JOB_CANCELLED', 'Provider request cancelled while queued', { status: 409 }));
    const lane = this.lane(provider);
    return new Promise((resolve, reject) => {
      const item = { operation, resolve, reject, signal, minIntervalMs };
      if (signal) {
        item.onAbort = () => {
          const index = lane.pending.indexOf(item);
          if (index >= 0) lane.pending.splice(index, 1);
          reject(signal.reason || new AppError('JOB_CANCELLED', 'Provider request cancelled while queued', { status: 409 }));
        };
        signal.addEventListener('abort', item.onAbort, { once: true });
      }
      lane.pending.push(item);
      void this.drain(provider, lane);
    });
  }

  async wait(delayMs, signal) {
    if (delayMs <= 0) return;
    await new Promise((resolve, reject) => {
      let onAbort;
      const timer = setTimeout(() => {
        if (onAbort) signal.removeEventListener('abort', onAbort);
        resolve();
      }, delayMs);
      if (!signal) return;
      onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason || new AppError('JOB_CANCELLED', 'Provider request cancelled while queued', { status: 409 }));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async drain(provider, lane = this.lane(provider)) {
    if (lane.running) return;
    lane.running = true;
    try {
      while (lane.pending.length) {
        const item = lane.pending.shift();
        if (item.signal?.aborted) continue;
        const interval = positiveInteger(item.minIntervalMs, this.policy(provider).minIntervalMs);
        try {
          await this.wait(Math.max(0, lane.lastStartedAt + interval - Date.now()), item.signal);
          if (item.signal?.aborted) throw item.signal.reason;
          lane.lastStartedAt = Date.now();
          item.resolve(await item.operation());
        } catch (error) {
          item.reject(error);
        } finally {
          if (item.onAbort) item.signal.removeEventListener('abort', item.onAbort);
        }
      }
    } finally {
      lane.running = false;
      if (lane.pending.length) void this.drain(provider, lane);
    }
  }

  status(provider) {
    const lane = this.lane(provider);
    return { provider, running: lane.running, pending: lane.pending.length, policy: this.policy(provider) };
  }
}

module.exports = { DEFAULT_PROVIDER_POLICIES, ProviderAdmissionQueue };
