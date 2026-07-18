const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// File-backed store for the exact-input reuse cache (dev/test — see prisma-generation-cache.repository.js
// for the production equivalent), mirroring idempotency-store.js's on-disk conventions. Entries are
// append-only per (tenantId, fingerprintHash): `lookup` returns the newest matching entry, `store`
// always writes a new file rather than overwriting an existing one — an explicit "generate a new
// variation" (bypassed: true) must never destroy a prior reusable result.
class GenerationCacheStore {
  constructor(root) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
  }

  prefix(tenantId, fingerprintHash) {
    return `${tenantId}__${fingerprintHash}__`;
  }

  // tenantId is part of the lookup key itself, not just stored metadata — a lookup query is
  // structurally incapable of returning another tenant's cached artifact.
  lookup(tenantId, fingerprintHash) {
    const prefix = this.prefix(tenantId, fingerprintHash);
    let newest = null;
    for (const name of fs.readdirSync(this.root)) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
      try {
        const entry = JSON.parse(fs.readFileSync(path.join(this.root, name), 'utf8'));
        if (!newest || new Date(entry.createdAt) > new Date(newest.createdAt)) newest = entry;
      } catch (_) { /* ignore a corrupt/partial file rather than fail the whole lookup */ }
    }
    return newest;
  }

  store(entry) {
    const id = crypto.randomUUID();
    const record = { id, createdAt: new Date().toISOString(), ...entry };
    const file = path.join(this.root, `${this.prefix(entry.tenantId, entry.fingerprintHash)}${Date.now()}-${id}.json`);
    const temp = `${file}.${id}.tmp`;
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    return record;
  }
}

module.exports = { GenerationCacheStore };
