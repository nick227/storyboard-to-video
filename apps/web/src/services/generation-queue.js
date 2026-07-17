const crypto = require('node:crypto');
const { AppError } = require('../errors');

class GenerationQueue {
  constructor({ concurrency = 1, retain = 200, store } = {}) {
    this.concurrency = Math.max(1, concurrency);
    this.retain = retain;
    this.jobs = new Map();
    this.pending = [];
    this.running = 0;
    this.store = store;
    for (const saved of store?.loadAndInterrupt?.() || []) this.jobs.set(saved.id, saved);
  }

  add(type, projectId, task, { sceneId, tenantId, userId } = {}) {
    const controller = new AbortController();
    const job = { id: crypto.randomUUID(), type, projectId: projectId || null, sceneId: sceneId || null, tenantId: tenantId || null, userId: userId || null, status: 'queued', createdAt: new Date().toISOString(), controller };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    this.jobs.set(job.id, job);
    this.store?.save(job);
    this.pending.push({ job, task });
    this.drain();
    return this.public(job, true);
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) throw new AppError('JOB_NOT_FOUND', 'Generation job not found', { status: 404 });
    if (this.isTerminal(job.status)) return this.public(job);
    job.status = 'cancelled';
    job.finishedAt = new Date().toISOString();
    this.store?.save(job);
    job.controller.abort(new AppError('JOB_CANCELLED', 'Generation job cancelled', { status: 409 }));
    job.reject(job.controller.signal.reason);
    this.pending = this.pending.filter((item) => item.job.id !== id);
    return this.public(job);
  }

  get(id) {
    const job = this.jobs.get(id);
    if (!job) throw new AppError('JOB_NOT_FOUND', 'Generation job not found', { status: 404 });
    return this.public(job);
  }

  list(projectId) {
    return [...this.jobs.values()].filter((job) => !projectId || job.projectId === projectId).map((job) => this.public(job));
  }

  cancelProject(projectId) {
    return [...this.jobs.values()].filter((job) => job.projectId === projectId && !this.isTerminal(job.status)).map((job) => this.cancel(job.id));
  }

  public(job, includePromise = false) {
    const value = { id: job.id, type: job.type, projectId: job.projectId, sceneId: job.sceneId, tenantId: job.tenantId, userId: job.userId, status: job.status, createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt, result: job.result, error: job.error };
    if (includePromise) value.promise = job.promise;
    return value;
  }

  async drain() {
    while (this.running < this.concurrency && this.pending.length) {
      const item = this.pending.shift();
      if (item.job.status === 'cancelled') continue;
      this.run(item);
    }
  }

  async run({ job, task }) {
    this.running += 1;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    this.store?.save(job);
    try {
      const result = await task(job.controller.signal, job.id);
      if (job.controller.signal.aborted) throw job.controller.signal.reason;
      job.status = 'succeeded'; job.result = result; this.store?.save(job); job.resolve(result);
    } catch (error) {
      if (job.status !== 'cancelled') { job.status = 'failed'; job.error = { code: error.code || 'GENERATION_FAILED', message: error.message }; this.store?.save(job); job.reject(error); }
    } finally {
      job.finishedAt ||= new Date().toISOString();
      this.store?.save(job);
      this.running -= 1;
      this.prune();
      this.drain();
    }
  }

  prune() {
    const finished = [...this.jobs.values()].filter((job) => this.isTerminal(job.status));
    finished.slice(0, Math.max(0, finished.length - this.retain)).forEach((job) => { this.jobs.delete(job.id); this.store?.delete(job.id); });
  }

  isTerminal(status) { return ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(status); }
}

module.exports = { GenerationQueue };
