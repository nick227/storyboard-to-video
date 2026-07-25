const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStylesService } = require('../src/services/styles.service');
const { MemoryCustomStyleRepository, PrismaCustomStyleRepository } = require('../src/storage/custom-style.repository');
const { createLocalBlobStore } = require('../src/storage/blob-store');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-styles-'));
  const config = {
    paths: {
      styles: path.join(root, 'styles'),
      styleReferences: path.join(root, 'style-references'),
      userStyleReferences: path.join(root, 'user-style-references'),
    },
  };
  Object.values(config.paths).forEach((directory) => fs.mkdirSync(directory, { recursive: true }));
  fs.writeFileSync(path.join(config.paths.styles, 'ink.md'), '# Ink\nBold lines');
  const repository = new MemoryCustomStyleRepository();
  const blobStore = createLocalBlobStore({ root: path.join(root, 'projects') });
  const service = createStylesService(config, { customStyles: repository, blobStore });
  return {
    root,
    repository,
    blobStore,
    service,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function image(name) {
  return { originalname: name, mimetype: 'image/png', buffer: PNG };
}

test('custom styles require a title and remain scoped to their owner', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      f.service.createCustom('user-1', { title: '   ', promptText: 'Anything' }),
      (error) => error.code === 'STYLE_TITLE_REQUIRED',
    );
    await assert.rejects(
      f.service.createCustom('user-1', { title: { unsafe: true }, promptText: '' }),
      (error) => error.code === 'VALIDATION_ERROR',
    );

    const created = await f.service.createCustom('user-1', {
      title: 'Paper Cutout',
      promptText: 'Layered paper shapes and tactile edges.',
      writingGuidance: 'Keep narration punchy and slide-like.',
    });
    assert.equal(created.kind, 'custom');
    assert.equal(created.editable, true);
    assert.equal(created.writingGuidance, 'Keep narration punchy and slide-like.');
    assert.equal(await f.service.resolve(created.id, 'user-2'), null);
    assert.deepEqual((await f.service.listCustom('user-2')), []);

    const available = await f.service.listAvailable('user-1');
    assert.deepEqual(available.map((style) => style.name), ['Ink', 'Paper Cutout']);
    assert.equal(available.find((style) => style.id === created.id).promptText, 'Layered paper shapes and tactile edges.');
    assert.equal(available.find((style) => style.id === created.id).writingGuidance, 'Keep narration punchy and slide-like.');
    assert.equal(available.find((style) => style.id === 'ink').writingGuidance, '');
  } finally {
    f.cleanup();
  }
});

test('custom style writing guidance can be updated independently of the visual prompt', async () => {
  const f = fixture();
  try {
    const created = await f.service.createCustom('user-1', {
      title: 'Deck',
      promptText: 'Clean corporate slides.',
    });
    assert.equal(created.writingGuidance, '');
    const updated = await f.service.updateCustom(created.id, 'user-1', {
      writingGuidance: 'One claim per beat. Short presenter voice.',
    });
    assert.equal(updated.promptText, 'Clean corporate slides.');
    assert.equal(updated.writingGuidance, 'One claim per beat. Short presenter voice.');
  } finally {
    f.cleanup();
  }
});

test('custom style references persist in blob storage, reorder, enforce limits, and delete cleanly', async () => {
  const f = fixture();
  try {
    const style = await f.service.createCustom('user-1', { title: 'Collage', promptText: 'Editorial collage.' });
    let references = await f.service.uploadCustomReferences(
      style.id,
      'characters',
      [image('first.png'), image('second.png')],
      'user-1',
    );
    assert.equal(references.characters.length, 2);
    assert.match(references.characters[0].url, new RegExp(`/api/custom-styles/${style.id}/references/`));

    const rows = await f.repository.listReferences(style.id, 'user-1');
    assert.equal(await f.blobStore.exists(rows[0].storageKey), true);
    assert.equal(await f.service.customReference(style.id, rows[0].id, 'user-2'), null);

    references = await f.service.reorderCustomReferences(
      style.id,
      'characters',
      [references.characters[1].id, references.characters[0].id],
      'user-1',
    );
    assert.deepEqual(references.characters.map((item) => item.fileName), ['second.png', 'first.png']);

    await assert.rejects(
      f.service.uploadCustomReferences(style.id, 'characters', [image('3.png'), image('4.png'), image('5.png')], 'user-1'),
      (error) => error.code === 'REFERENCE_LIMIT',
    );

    const sourceRows = await f.service.resolveReferenceSources(style.id, 'user-1');
    assert.deepEqual(sourceRows.map((item) => item.fileName), ['second.png', 'first.png']);
    assert.ok(sourceRows.every((item) => item.storageKey));

    const removedKey = rows[0].storageKey;
    await f.service.removeCustomReference(style.id, rows[0].id, 'user-1');
    assert.equal(await f.blobStore.exists(removedKey), false);
    assert.equal((await f.repository.listReferences(style.id, 'user-1')).length, 1);
  } finally {
    f.cleanup();
  }
});

test('resolveReferences for custom styles does not create shared style-references folders', async () => {
  const f = fixture();
  try {
    const style = await f.service.createCustom('user-1', { title: 'Paper Origami', promptText: 'Folded paper.' });
    await f.service.resolveReferences(style.id, 'user-1');
    assert.equal(fs.existsSync(path.join(f.root, 'style-references', style.id)), false);
    assert.equal(fs.existsSync(path.join(f.root, 'user-style-references', 'user-1', style.id)), false);
  } finally {
    f.cleanup();
  }
});

test('archived custom styles leave menus but remain resolvable for existing projects', async () => {
  const f = fixture();
  try {
    const style = await f.service.createCustom('user-1', { title: 'Vintage Print', promptText: 'Aged ink.' });
    const archived = await f.service.archiveCustom(style.id, 'user-1');
    assert.equal(archived.status, 'archived');
    assert.deepEqual(await f.service.listCustom('user-1'), []);
    assert.equal((await f.service.resolve(style.id, 'user-1')).name, 'Vintage Print');
    assert.equal(await f.service.resolve(style.id, 'user-1', { includeArchived: false }), null);
  } finally {
    f.cleanup();
  }
});

test('the Prisma repository rejects malformed UUIDs without issuing a database query', async () => {
  let queried = false;
  const repository = new PrismaCustomStyleRepository({
    customStyle: {
      findFirst: async () => {
        queried = true;
        throw new Error('should not query');
      },
    },
  });
  assert.equal(await repository.findOwned('null', '00000000-0000-4000-8000-000000000001'), null);
  assert.equal(queried, false);
});

test('custom style reference generation checks idempotency key and handles concurrent limit', async () => {
  const f = fixture();
  try {
    const style = await f.service.createCustom('user-1', { title: 'Sketchbook', promptText: 'Ink sketch.' });
    
    let callCount = 0;
    const mockImageProvider = {
      generate: async ({ provider, prompt, title, output }) => {
        callCount++;
        return {
          output: {
            buffer: PNG,
            mimeType: 'image/png',
            extension: 'png',
          },
          provider: 'stub',
          model: 'stub-model',
          generationRequestId: '61a5b82d-8693-4903-8d3f-bbfefdfd0cf8',
        };
      }
    };

    const key = 'idem-key-1';
    let refs = await f.service.generateCustomReference(style.id, 'characters', 'stub', 'user-1', {
      imageProvider: mockImageProvider,
      idempotencyKey: key
    });
    assert.equal(refs.characters.length, 1);
    assert.equal(callCount, 1);

    // Replay idempotency check
    refs = await f.service.generateCustomReference(style.id, 'characters', 'stub', 'user-1', {
      imageProvider: mockImageProvider,
      idempotencyKey: key
    });
    assert.equal(refs.characters.length, 1);
    assert.equal(callCount, 1);

    // Validate provenance
    const rows = await f.repository.listReferences(style.id, 'user-1');
    assert.equal(rows[0].source, 'ai_generated');
    assert.equal(rows[0].promptSnapshot, 'Ink sketch.');
    assert.equal(rows[0].provider, 'stub');
    assert.equal(rows[0].model, 'stub-model');
    assert.equal(rows[0].aspectRatio, '3:4');
    assert.equal(rows[0].generationRequestId, '61a5b82d-8693-4903-8d3f-bbfefdfd0cf8');

    // Add up to the limit
    await f.service.generateCustomReference(style.id, 'characters', 'stub', 'user-1', { imageProvider: mockImageProvider });
    await f.service.generateCustomReference(style.id, 'characters', 'stub', 'user-1', { imageProvider: mockImageProvider });
    await f.service.generateCustomReference(style.id, 'characters', 'stub', 'user-1', { imageProvider: mockImageProvider });

    // Exceeding limit should reject
    await assert.rejects(
      f.service.generateCustomReference(style.id, 'characters', 'stub', 'user-1', { imageProvider: mockImageProvider }),
      (err) => err.code === 'REFERENCE_LIMIT'
    );
  } finally {
    f.cleanup();
  }
});

test('custom style reference generation handles provider, storage, and database failures gracefully', async () => {
  const f = fixture();
  try {
    const style = await f.service.createCustom('user-1', { title: 'Watercolor', promptText: 'Soft watercolor.' });
    
    // 1. Provider failure rollback
    const failingProvider = {
      generate: async () => {
        throw new Error('API Error');
      }
    };
    await assert.rejects(
      f.service.generateCustomReference(style.id, 'characters', 'stub', 'user-1', { imageProvider: failingProvider }),
      (err) => err.message === 'API Error'
    );
    let refs = await f.repository.listReferences(style.id, 'user-1');
    assert.equal(refs.length, 0);

    // 2. Storage failure rollback
    const mockImageProvider = {
      generate: async () => ({
        output: { buffer: PNG, mimeType: 'image/png', extension: 'png' },
        provider: 'stub',
        model: 'stub-model',
      })
    };
    f.blobStore.put = async () => {
      throw new Error('Disk full');
    };
    await assert.rejects(
      f.service.generateCustomReference(style.id, 'characters', 'stub', 'user-1', { imageProvider: mockImageProvider }),
      (err) => err.message === 'Disk full'
    );
    refs = await f.repository.listReferences(style.id, 'user-1');
    assert.equal(refs.length, 0);

    // 3. Database activation failure after successful storage
    const originalPut = f.blobStore.put;
    let putCalled = false;
    f.blobStore.put = async (key, file, options) => {
      putCalled = true;
    };
    
    f.repository.updateReference = async (refId, styleId, userId, patch) => {
      if (patch.status === 'active') {
        throw new Error('DB Connection Timed Out');
      }
      // Allow marking as failed
      const ref = f.repository.references.get(refId);
      if (ref) ref.status = patch.status;
      return ref;
    };

    await assert.rejects(
      f.service.generateCustomReference(style.id, 'characters', 'stub', 'user-1', { imageProvider: mockImageProvider }),
      (err) => err.message === 'DB Connection Timed Out'
    );
    assert.equal(putCalled, true);
    
    // The slot is marked failed and released
    refs = await f.repository.listReferences(style.id, 'user-1');
    assert.equal(refs.length, 0);
  } finally {
    f.cleanup();
  }
});
