const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const RECOVERABLE_STATES = Object.freeze(['queued', 'submitted', 'provider_running', 'downloading', 'validating']);

function clone(value) { return structuredClone(value); }

class VideoGenerationAttemptStore {
  constructor(root) { this.root = path.resolve(root); fs.mkdirSync(this.root, { recursive: true }); }
  file(id) { return path.join(this.root, `${id}.json`); }
  write(attempt) {
    const temp = path.join(this.root, `.${attempt.id}-${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(temp, `${JSON.stringify(attempt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, this.file(attempt.id));
    return clone(attempt);
  }
  create(data) {
    const now = new Date().toISOString();
    return this.write({ id: crypto.randomUUID(), retryCount: 0, cancellationState: 'not_requested', downloadState: 'pending', commitState: 'pending', ...clone(data), createdAt: now, updatedAt: now });
  }
  get(id) { return clone(JSON.parse(fs.readFileSync(this.file(id), 'utf8'))); }
  update(id, patch) {
    const current = this.get(id);
    // requestSnapshot, provider/model/mode and inputHashes are immutable after create.
    const next = { ...current, ...clone(patch), id: current.id, provider: current.provider, model: current.model, generationMode: current.generationMode, requestSnapshot: current.requestSnapshot, inputHashes: current.inputHashes, updatedAt: new Date().toISOString() };
    return this.write(next);
  }
  listRecoverable(now = new Date()) {
    return fs.readdirSync(this.root).filter((name) => name.endsWith('.json')).flatMap((name) => {
      try {
        const attempt = JSON.parse(fs.readFileSync(path.join(this.root, name), 'utf8'));
        return RECOVERABLE_STATES.includes(attempt.lifecycleState) && (!attempt.pollAfter || new Date(attempt.pollAfter) <= now) ? [attempt] : [];
      } catch (_) { return []; }
    }).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt) || a.id.localeCompare(b.id));
  }
}

module.exports = { RECOVERABLE_STATES, VideoGenerationAttemptStore };
