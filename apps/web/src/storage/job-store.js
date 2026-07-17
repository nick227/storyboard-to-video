const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class JobStore {
  constructor(root) { this.root = path.resolve(root); fs.mkdirSync(this.root, { recursive: true }); }
  file(id) { return path.join(this.root, `${id}.json`); }
  save(job) {
    const value = { id: job.id, type: job.type, projectId: job.projectId, sceneId: job.sceneId, tenantId: job.tenantId, userId: job.userId, idempotencyKey: job.idempotencyKey, status: job.status, createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt, result: job.result, error: job.error };
    const temp = path.join(this.root, `.${job.id}-${crypto.randomUUID()}.tmp`);
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.file(job.id));
    const dirFd = fs.openSync(this.root, 'r'); try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  }
  loadAndInterrupt() {
    return fs.readdirSync(this.root).filter((name) => name.endsWith('.json')).flatMap((name) => {
      try {
        const job = JSON.parse(fs.readFileSync(path.join(this.root, name), 'utf8'));
        if (['queued', 'running'].includes(job.status)) {
          job.status = 'interrupted'; job.finishedAt = new Date().toISOString(); job.error = { code: 'SERVER_RESTARTED', message: 'Job was interrupted by a server restart' }; this.save(job);
        }
        return [job];
      } catch (_) { return []; }
    });
  }
  delete(id) { fs.rmSync(this.file(id), { force: true }); }
}

module.exports = { JobStore };
