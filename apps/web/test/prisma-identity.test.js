const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PrismaIdentityRepository } = require('../src/storage/prisma-identity.repository');

const databaseUrl = process.env.PRISMA_INTEGRATION_TESTS === '1' ? process.env.DATABASE_URL : '';

test('Prisma identity repository persists transactional registration and sessions', { skip: !databaseUrl }, async () => {
  const repository = new PrismaIdentityRepository(databaseUrl);
  const suffix = crypto.randomUUID();
  const email = `prisma-${suffix}@example.com`;
  let identity;
  try {
    identity = await repository.createUserWithPersonalWorkspace({ email, displayName: 'Prisma User', passwordHash: 'test-hash' });
    assert.equal(identity.user.email, email);
    assert.equal(identity.tenant.type, 'personal');
    assert.equal((await repository.findUserByEmail(email)).role, 'owner');

    const hash = crypto.createHash('sha256').update(suffix).digest('hex');
    await repository.createSession({ tokenHash: hash, userId: identity.user.id, tenantId: identity.tenant.id, expiresAt: new Date(Date.now() + 60_000) });
    assert.equal((await repository.findSession(hash)).user.id, identity.user.id);
    await repository.deleteSession(hash);
    assert.equal(await repository.findSession(hash), null);
  } finally {
    if (identity) {
      await repository.prisma.user.deleteMany({ where: { id: identity.user.id } });
      await repository.prisma.workspace.deleteMany({ where: { id: identity.tenant.id } });
    }
    await repository.disconnect();
  }
});
