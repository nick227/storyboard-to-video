const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStylesService } = require('../src/services/styles.service');
const { PrismaCustomStyleRepository } = require('../src/storage/custom-style.repository');
const { createPrismaClient } = require('../src/storage/prisma-client');
const { createLocalBlobStore } = require('../src/storage/blob-store');
const { PrismaIdentityRepository } = require('../src/storage/prisma-identity.repository');

const enabled = process.env.PRISMA_INTEGRATION_TESTS === '1';

test('custom styles concurrent generation with real Postgres', { skip: !enabled }, async () => {
  const prisma = createPrismaClient(process.env.DATABASE_URL);
  const identityRepository = new PrismaIdentityRepository(prisma);
  const customStyles = new PrismaCustomStyleRepository(prisma);
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-styles-pg-concurrency-'));
  const config = {
    paths: {
      styleReferences: path.join(root, 'style-references'),
      userStyleReferences: path.join(root, 'user-style-references'),
    },
  };
  Object.values(config.paths).forEach((directory) => fs.mkdirSync(directory, { recursive: true }));
  
  const blobStore = createLocalBlobStore({ root: path.join(root, 'projects') });
  const service = createStylesService(config, { customStyles, blobStore });

  // Create a real database user/workspace
  const suffix = crypto.randomUUID();
  const email = `styles-concurrency-${suffix}@example.com`;
  const account = await identityRepository.createUserWithPersonalWorkspace({
    email,
    displayName: 'Concurrency Tester',
    passwordHash: 'dummy'
  });

  const userId = account.user.id;
  const style = await service.createCustom(userId, { title: 'Comic Style', promptText: 'Rich colors.' });

  try {
    // 1. Seed exactly 3 references (so only 1 free slot remains, e.g. slot 3)
    for (let i = 0; i < 3; i++) {
      await customStyles.addReference(style.id, userId, {
        id: crypto.randomUUID(),
        category: 'characters',
        fileName: `seeded-${i}.png`,
        storageKey: `seeded-key-${i}`,
        mimeType: 'image/png',
        byteSize: 100,
        sortOrder: i,
        status: 'active',
        source: 'user_upload'
      });
    }

    // 2. Setup mock image provider that delays slightly to increase concurrent race condition probability
    let generateCount = 0;
    const mockImageProvider = {
      generate: async () => {
        generateCount++;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          output: {
            buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            mimeType: 'image/png',
            extension: 'png',
          },
          provider: 'stub',
          model: 'stub-model',
          generationRequestId: crypto.randomUUID(),
        };
      }
    };

    // 3. Fire 10 concurrent requests at the same time
    const requests = Array.from({ length: 10 }).map(() =>
      service.generateCustomReference(style.id, 'characters', 'stub', userId, {
        imageProvider: mockImageProvider
      })
    );

    const outcomes = await Promise.allSettled(requests);

    // 4. Assert exactly 1 request succeeded and exactly 9 failed due to limit/conflict
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 9);
    assert.equal(generateCount, 1);

    // Verify error codes of rejected ones: should be REFERENCE_LIMIT or unique constraint failure
    rejected.forEach((rej) => {
      assert.ok(
        rej.reason.code === 'REFERENCE_LIMIT' || 
        (rej.reason.cause && (rej.reason.cause.code === 'P2002' || rej.reason.cause.message.includes('Unique constraint')))
      );
    });

    // 5. Assert database has exactly 4 references (3 seeded + 1 generated)
    const finalRefs = await customStyles.listReferences(style.id, userId);
    assert.equal(finalRefs.length, 4);

    // Verify only one provider call and exactly 4 rows total exist in the DB (no leaked/duplicate slots)
    const allDbRows = await prisma.customStyleReference.findMany({ where: { styleId: style.id } });
    assert.equal(allDbRows.length, 4);
    assert.equal(allDbRows.filter(r => r.status === 'active').length, 4);

    // Validate that the new slot has sortOrder: 3
    const newSlot = finalRefs.find((r) => r.fileName.startsWith('generated-'));
    assert.ok(newSlot);
    assert.equal(newSlot.sortOrder, 3);
  } finally {
    // Cleanup database rows
    await prisma.$executeRawUnsafe('ALTER TABLE credit_ledger_entries DISABLE TRIGGER USER');
    await prisma.$executeRawUnsafe('ALTER TABLE provider_cost_snapshots DISABLE TRIGGER USER');
    try {
      await prisma.customStyleReference.deleteMany({ where: { styleId: style.id } });
      await prisma.customStyle.deleteMany({ where: { id: style.id } });
      await prisma.creditLedgerEntry.deleteMany({ where: { tenantId: account.tenant.id } });
      await prisma.creditAccount.deleteMany({ where: { tenantId: account.tenant.id } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.workspace.deleteMany({ where: { id: account.tenant.id } });
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE credit_ledger_entries ENABLE TRIGGER USER');
      await prisma.$executeRawUnsafe('ALTER TABLE provider_cost_snapshots ENABLE TRIGGER USER');
    }
    await prisma.$disconnect();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
