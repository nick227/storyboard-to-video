const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AppError } = require('../errors');

class IdempotencyStore {
  constructor(root) { this.root = path.resolve(root); fs.mkdirSync(this.root, { recursive: true }); this.interruptActive(); }
  digest(projectId, key) { return crypto.createHash('sha256').update(`${projectId}\0${key}`).digest('hex'); }
  file(projectId, key) { return path.join(this.root, `${this.digest(projectId, key)}.json`); }
  payloadHash(body) { return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex'); }
  read(projectId, key) { try { return JSON.parse(fs.readFileSync(this.file(projectId, key), 'utf8')); } catch (_) { return null; } }
  save(record) { const file = this.file(record.projectId, record.key); const temp = `${file}.${crypto.randomUUID()}.tmp`; const fd = fs.openSync(temp, 'wx', 0o600); try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(temp, file); const dirFd = fs.openSync(this.root, 'r'); try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); } }
  begin(projectId, key, body) {
    const hash = this.payloadHash(body); const existing = this.read(projectId, key);
    if (existing && existing.payloadHash !== hash) throw new AppError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with a different request', { status: 409 });
    if (existing?.status === 'completed' || existing?.status === 'active') return { reused: true, record: existing };
    const record = { projectId, key, payloadHash: hash, status: 'active', createdAt: new Date().toISOString() }; this.save(record); return { reused: false, record };
  }
  attach(projectId, key, jobId) { const record = this.read(projectId, key); if (record) { record.jobId = jobId; this.save(record); } }
  complete(projectId, key, statusCode, body) { const record = this.read(projectId, key); if (record) { record.status = 'completed'; record.statusCode = statusCode; record.body = body; record.finishedAt = new Date().toISOString(); this.save(record); } }
  fail(projectId, key) { const record = this.read(projectId, key); if (record?.status === 'active') fs.rmSync(this.file(projectId, key), { force: true }); }
  interruptActive() { for (const name of fs.readdirSync(this.root).filter((x) => x.endsWith('.json'))) { try { const file = path.join(this.root, name); const record = JSON.parse(fs.readFileSync(file, 'utf8')); if (record.status === 'active') { record.status = 'interrupted'; record.finishedAt = new Date().toISOString(); this.save(record); } } catch (_) {} } }
}

module.exports = { IdempotencyStore };
