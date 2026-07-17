const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPrismaClient } = require('../src/storage/prisma-client');
const { PrismaIdentityRepository } = require('../src/storage/prisma-identity.repository');
const { PrismaProjectRepository } = require('../src/storage/prisma-project.repository');
const { PrismaJobRepository } = require('../src/storage/prisma-job.repository');
const { PrismaIdempotencyRepository } = require('../src/storage/prisma-idempotency.repository');

const enabled = process.env.PRISMA_INTEGRATION_TESTS === '1';

test('Prisma metadata repositories persist tenant projects, assets, jobs, and idempotency', { skip: !enabled }, async () => {
  const prisma = createPrismaClient(process.env.DATABASE_URL);
  const identity = new PrismaIdentityRepository(prisma);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-metadata-'));
  let userId;
  let tenantId;
  try {
    const account = await identity.createUserWithPersonalWorkspace({
      email: `metadata-${crypto.randomUUID()}@example.com`, displayName: 'Metadata Test', passwordHash: 'test-only',
    });
    userId = account.user.id;
    tenantId = account.tenant.id;
    const projects = new PrismaProjectRepository(root, prisma);
    const created = await projects.create({ id: `metadata-${crypto.randomUUID()}`, title: 'Metadata', project: { scenes: [{ id: 'scene-1' }] } }, { tenantId: account.tenant.id, createdByUserId: account.user.id });
    const updated = await projects.write(created.id, { ...created, title: 'Updated' }, { ownerId: account.tenant.id, expectedRevision: created.revision });
    assert.equal(updated.revision, 2);

    const staged = path.join(root, 'staged.bin');
    fs.writeFileSync(staged, Buffer.from('asset bytes'));
    const asset = await projects.commitAsset(await projects.acquireLease(created.id, { ownerId: account.tenant.id }), 'images', staged, { fileName: 'scene.bin', mimeType: 'application/octet-stream' });
    assert.equal((await projects.findAsset(created.id, 'images', 'scene.bin', { ownerId: account.tenant.id })).path, asset.path);

    const jobs = new PrismaJobRepository(prisma);
    const jobId = crypto.randomUUID();
    await jobs.save({ id: jobId, type: 'image', projectId: created.id, sceneId: 'scene-1', tenantId: account.tenant.id, userId: account.user.id, status: 'queued', createdAt: new Date().toISOString() });
    assert.equal((await jobs.loadAndInterrupt()).find((job) => job.id === jobId).status, 'interrupted');

    const idempotency = new PrismaIdempotencyRepository(prisma);
    const begun = await idempotency.begin(created.id, 'metadata-request-001', { value: 1 }, { tenantId: account.tenant.id, userId: account.user.id });
    assert.equal(begun.reused, false);
    await idempotency.attach(created.id, 'metadata-request-001', jobId);
    await idempotency.complete(created.id, 'metadata-request-001', 200, { ok: true });
    const replay = await idempotency.begin(created.id, 'metadata-request-001', { value: 1 }, { tenantId: account.tenant.id, userId: account.user.id });
    assert.deepEqual(replay.record.body, { ok: true });
  } finally {
    if (tenantId) await prisma.workspace.deleteMany({ where: { id: tenantId } });
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
