const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { slugify, cleanText } = require('../shared/text');
const { detectImageExtension } = require('../media/image-format');
const { AppError } = require('../errors');
const { buildCustomStyleReferenceStorageKey } = require('../storage/blob-store');
const { mergeMediaIntent, resolveImageOutput } = require('../shared/media-output-policy');
const { dezgoModelForProvider, isDezgoProvider } = require('../providers/image/dezgo-settings');

function createStylesService(config, { customStyles = null, blobStore = null } = {}) {
  const sanitize = (id = '') => slugify(id);
  const normalizeType = (type = '') => type === 'world' ? 'world' : 'characters';
  const referenceDir = (id, type) => path.join(config.paths.styleReferences, sanitize(id), normalizeType(type));
  const userReferenceDir = (id, type, userId) => path.join(config.paths.userStyleReferences, String(userId), sanitize(id), normalizeType(type));
  const publicPath = (id, type, file, isUser) => isUser ? `/user-style-references/${sanitize(id)}/${normalizeType(type)}/${encodeURIComponent(file)}` : `/style-references/${sanitize(id)}/${normalizeType(type)}/${encodeURIComponent(file)}`;
  const hiddenDefaultsPath = (userId) => path.join(config.paths.userStyleReferences, String(userId), 'hidden-defaults.json');
  function readHiddenDefaults(userId) {
    if (!userId) return {};
    try { return JSON.parse(fs.readFileSync(hiddenDefaultsPath(userId), 'utf8')) || {}; } catch (_) { return {}; }
  }
  function writeHiddenDefaults(userId, data) {
    const file = hiddenDefaultsPath(userId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  }
  function isHiddenDefault(id, type, fileName, userId) {
    if (!userId) return false;
    const list = readHiddenDefaults(userId)?.[sanitize(id)]?.[normalizeType(type)];
    return Array.isArray(list) && list.includes(fileName);
  }
  function hideDefault(id, type, fileName, userId) {
    const styleKey = sanitize(id), normalized = normalizeType(type);
    const hidden = readHiddenDefaults(userId);
    hidden[styleKey] = hidden[styleKey] || {};
    const list = new Set(hidden[styleKey][normalized] || []);
    list.add(fileName);
    hidden[styleKey][normalized] = [...list];
    writeHiddenDefaults(userId, hidden);
  }
  function unhideDefault(id, type, fileName, userId) {
    const styleKey = sanitize(id), normalized = normalizeType(type);
    const hidden = readHiddenDefaults(userId);
    if (hidden[styleKey]?.[normalized]) {
      const list = new Set(hidden[styleKey][normalized]);
      list.delete(fileName);
      hidden[styleKey][normalized] = [...list];
      writeHiddenDefaults(userId, hidden);
    }
  }
  function referenceFiles(id, type, userId, includeHidden = false) {
    const globalDir = referenceDir(id, type); fs.mkdirSync(globalDir, { recursive: true });
    const globalFiles = fs.readdirSync(globalDir)
      .filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f))
      .filter((f) => includeHidden || !isHiddenDefault(id, type, f, userId))
      .sort()
      .map((f) => ({ fileName: f, path: path.join(globalDir, f), url: publicPath(id, type, f, false), type: normalizeType(type), isUserUploaded: false }));
    let userFiles = [];
    if (userId) {
      const userDir = userReferenceDir(id, type, userId); fs.mkdirSync(userDir, { recursive: true });
      userFiles = fs.readdirSync(userDir)
        .filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f))
        .filter((f) => includeHidden || !isHiddenDefault(id, type, f, userId))
        .sort()
        .map((f) => ({ fileName: f, path: path.join(userDir, f), url: publicPath(id, type, f, true), type: normalizeType(type), isUserUploaded: true }));
    }
    return [...globalFiles, ...userFiles];
  }
  const references = (id, userId, options = {}) => ({
    characters: referenceFiles(id, 'characters', userId, options.all).map(publicRecord),
    world: referenceFiles(id, 'world', userId, options.all).map(publicRecord)
  });
  function publicRecord({ fileName, url, type, isUserUploaded }) { return { fileName, url, type, isUserUploaded }; }
  function readSystemWritingGuidance(id) {
    const file = path.join(config.paths.styles, 'writing', `${sanitize(id)}.md`);
    if (!fs.existsSync(file)) return '';
    return cleanText(fs.readFileSync(file, 'utf8'), 1_000);
  }
  function parseSystemStyleMarkdown(content, id, file) {
    const trimmed = String(content || '').trim();
    const lines = trimmed.split('\n');
    return {
      id,
      name: (lines[0] || '').replace(/^#\s*/, '').trim() || id,
      promptText: lines.slice(1).join('\n').trim(),
      writingGuidance: readSystemWritingGuidance(id),
      file,
      kind: 'system',
      editable: false,
    };
  }
  function list(userId) {
    return fs.readdirSync(config.paths.styles)
      .filter((file) => file.endsWith('.md') && !file.includes(path.sep))
      .map((file) => {
        const id = file.replace(/\.md$/, '');
        return parseSystemStyleMarkdown(fs.readFileSync(path.join(config.paths.styles, file), 'utf8'), id, file);
      });
  }
  const find = (id, userId) => list(userId).find((style) => style.id === id) || null;
  const customRecord = (style) => style ? {
    id: style.id,
    name: style.title,
    promptText: style.promptText || '',
    writingGuidance: style.writingGuidance || '',
    kind: 'custom',
    editable: true,
    status: style.status,
    updatedAt: style.updatedAt,
  } : null;
  async function listAvailable(userId) {
    const personal = customStyles && userId ? await customStyles.list(userId) : [];
    return [...list(userId), ...personal.map(customRecord)];
  }
  async function listCustom(userId) {
    if (!customStyles || !userId) return [];
    return (await customStyles.list(userId)).map(customRecord);
  }
  async function resolve(id, userId, { includeArchived = true } = {}) {
    const builtIn = find(id, userId);
    if (builtIn) return builtIn;
    if (!customStyles || !userId) return null;
    return customRecord(await customStyles.findOwned(id, userId, { includeArchived }));
  }
  function customReferenceRecord(styleId, reference) {
    return {
      id: reference.id,
      fileName: reference.fileName,
      url: `/api/custom-styles/${encodeURIComponent(styleId)}/references/${encodeURIComponent(reference.id)}/content`,
      type: reference.category,
      isUserUploaded: true,
      isCustomStyle: true,
    };
  }
  async function resolveReferences(id, userId, options = {}) {
    if (find(id, userId)) return references(id, userId, options);
    const style = await resolve(id, userId);
    if (!style) throw new AppError('STYLE_NOT_FOUND', 'Unknown style', { status: 404 });
    const rows = await customStyles.listReferences(id, userId);
    return {
      characters: rows.filter((item) => item.category === 'characters').map((item) => customReferenceRecord(id, item)),
      world: rows.filter((item) => item.category === 'world').map((item) => customReferenceRecord(id, item)),
    };
  }
  // `order` is the project's own client-set display order (project.styleReferenceOrder, see
  // style-controller.js), applied here -- not just for display -- because it also decides which
  // files survive the slice(0, 4) cap below when a style has more than 4 references of a type.
  function sortByOrder(files, order) {
    if (!Array.isArray(order) || !order.length) return files;
    const rank = new Map(order.map((fileName, index) => [fileName, index]));
    return [...files].sort((a, b) => (rank.has(a.fileName) ? rank.get(a.fileName) : Infinity) - (rank.has(b.fileName) ? rank.get(b.fileName) : Infinity));
  }
  const referenceSources = (id, userId, order = {}) => [
    ...sortByOrder(referenceFiles(id, 'characters', userId), order.characters).slice(0, 4),
    ...sortByOrder(referenceFiles(id, 'world', userId), order.world).slice(0, 4),
  ].slice(0, 8);
  const referencePaths = (id, userId) => referenceSources(id, userId).map((item) => item.path);
  async function resolveReferenceSources(id, userId, order = {}) {
    if (find(id, userId)) return referenceSources(id, userId, order);
    if (!await resolve(id, userId)) throw new AppError('STYLE_NOT_FOUND', 'Unknown style', { status: 404 });
    const rows = (await customStyles.listReferences(id, userId)).filter((item) => item.status === 'active');
    return rows.slice(0, 8).map((item) => ({
      storageKey: item.storageKey,
      url: `/api/custom-styles/${encodeURIComponent(id)}/references/${encodeURIComponent(item.id)}/content`,
      type: item.category,
      fileName: item.fileName,
      isUserUploaded: true,
    }));
  }
  function upload(id, type, files, userId) {
    if (!userId) throw new AppError('UNAUTHENTICATED', 'Not authenticated', { status: 401 });
    if (!find(id, userId)) throw new AppError('STYLE_NOT_FOUND', 'Unknown style', { status: 404 });
    const normalized = normalizeType(type), existing = referenceFiles(id, normalized, userId);
    if (!files?.length) throw new AppError('VALIDATION_ERROR', 'At least one image is required', { status: 400 });
    if (existing.length + files.length > 8) throw new AppError('REFERENCE_LIMIT', `A style can have at most 8 ${normalized} references`, { status: 400 });
    const prepared = files.map((file) => ({ file, extension: detectImageExtension(file.buffer) }));
    if (prepared.some((x) => !x.extension)) throw new AppError('INVALID_IMAGE', 'Only valid PNG, JPEG, WebP, and GIF images are accepted', { status: 400 });
    const dir = userReferenceDir(id, normalized, userId); fs.mkdirSync(dir, { recursive: true });
    prepared.forEach(({ file, extension }, i) => fs.writeFileSync(path.join(dir, `${Date.now()}-${i}-${slugify(path.basename(file.originalname, path.extname(file.originalname)))}.${extension}`), file.buffer));
    return references(id, userId);
  }
  function remove(id, type, fileName, userId, deleteFile = false) {
    if (!userId) throw new AppError('UNAUTHENTICATED', 'Not authenticated', { status: 401 });
    if (!find(id, userId)) throw new AppError('STYLE_NOT_FOUND', 'Unknown style', { status: 404 });
    const safe = path.basename(fileName || '');
    if (!safe || safe !== fileName) throw new AppError('INVALID_PATH', 'Invalid reference filename', { status: 400 });
    const userPath = path.join(userReferenceDir(id, type, userId), safe);
    const globalPath = path.join(referenceDir(id, type), safe);
    if (deleteFile) {
      if (fs.existsSync(userPath)) {
        fs.rmSync(userPath, { force: true });
        unhideDefault(id, type, safe, userId);
        return references(id, userId);
      }
    } else {
      if (fs.existsSync(userPath) || fs.existsSync(globalPath)) {
        hideDefault(id, type, safe, userId);
        return references(id, userId);
      }
    }
    throw new AppError('NOT_FOUND', 'Reference not found or cannot be removed', { status: 404 });
  }
  function activate(id, type, fileName, userId) {
    if (!userId) throw new AppError('UNAUTHENTICATED', 'Not authenticated', { status: 401 });
    if (!find(id, userId)) throw new AppError('STYLE_NOT_FOUND', 'Unknown style', { status: 404 });
    const safe = path.basename(fileName || '');
    if (!safe || safe !== fileName) throw new AppError('INVALID_PATH', 'Invalid reference filename', { status: 400 });
    const userPath = path.join(userReferenceDir(id, type, userId), safe);
    const globalPath = path.join(referenceDir(id, type), safe);
    if (fs.existsSync(userPath) || fs.existsSync(globalPath)) {
      unhideDefault(id, type, safe, userId);
      return references(id, userId);
    }
    throw new AppError('NOT_FOUND', 'Reference not found or cannot be activated', { status: 404 });
  }

  function validatedStyleInput(input = {}, { partial = false } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new AppError('VALIDATION_ERROR', 'Custom style data must be an object', { status: 400 });
    }
    const result = {};
    if (!partial || input.title !== undefined) {
      if (input.title !== undefined && typeof input.title !== 'string') {
        throw new AppError('VALIDATION_ERROR', 'Custom style title must be text', { status: 400 });
      }
      result.title = cleanText(input.title, 120);
      if (!result.title) throw new AppError('STYLE_TITLE_REQUIRED', 'A custom style title is required', { status: 400 });
    }
    if (!partial || input.promptText !== undefined) {
      if (input.promptText !== undefined && typeof input.promptText !== 'string') {
        throw new AppError('VALIDATION_ERROR', 'Custom style prompt must be text', { status: 400 });
      }
      result.promptText = cleanText(input.promptText, 12_000);
    }
    if (!partial || input.writingGuidance !== undefined) {
      if (input.writingGuidance !== undefined && typeof input.writingGuidance !== 'string') {
        throw new AppError('VALIDATION_ERROR', 'Custom style writing guidance must be text', { status: 400 });
      }
      result.writingGuidance = cleanText(input.writingGuidance, 1_000);
    }
    return result;
  }

  async function createCustom(userId, input) {
    if (!customStyles || !userId) throw new AppError('UNAUTHENTICATED', 'Not authenticated', { status: 401 });
    return customRecord(await customStyles.create(userId, validatedStyleInput(input)));
  }

  async function updateCustom(id, userId, input) {
    if (!customStyles || !userId) throw new AppError('UNAUTHENTICATED', 'Not authenticated', { status: 401 });
    return customRecord(await customStyles.update(id, userId, validatedStyleInput(input, { partial: true })));
  }

  async function archiveCustom(id, userId) {
    if (!customStyles || !userId) throw new AppError('UNAUTHENTICATED', 'Not authenticated', { status: 401 });
    return customRecord(await customStyles.archive(id, userId));
  }

  async function uploadCustomReferences(id, category, files, userId) {
    if (!customStyles || !blobStore || !userId) throw new AppError('UNAUTHENTICATED', 'Not authenticated', { status: 401 });
    const normalized = normalizeType(category);
    const existing = (await customStyles.listReferences(id, userId)).filter((item) => item.category === normalized);
    if (!files?.length) throw new AppError('VALIDATION_ERROR', 'At least one image is required', { status: 400 });
    if (existing.length + files.length > 4) throw new AppError('REFERENCE_LIMIT', `A custom style can have at most 4 ${normalized} references`, { status: 400 });
    const prepared = files.map((file) => ({ file, extension: detectImageExtension(file.buffer) }));
    if (prepared.some((item) => !item.extension)) throw new AppError('INVALID_IMAGE', 'Only valid PNG, JPEG, WebP, and GIF images are accepted', { status: 400 });

    for (const [offset, item] of prepared.entries()) {
      const referenceId = crypto.randomUUID();
      const fileName = `${referenceId}.${item.extension}`;
      const storageKey = buildCustomStyleReferenceStorageKey(userId, id, fileName);
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-style-reference-'));
      const staged = path.join(tempDir, fileName);
      fs.writeFileSync(staged, item.file.buffer);
      try {
        await blobStore.put(storageKey, staged, { mimeType: item.file.mimetype, byteSize: item.file.buffer.length });
        try {
          await customStyles.addReference(id, userId, {
            id: referenceId,
            category: normalized,
            fileName: cleanText(item.file.originalname, 240) || fileName,
            storageKey,
            mimeType: item.file.mimetype || `image/${item.extension}`,
            byteSize: item.file.buffer.length,
            sortOrder: existing.length + offset,
          });
        } catch (error) {
          await blobStore.delete(storageKey).catch(() => {});
          throw error;
        }
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
    return resolveReferences(id, userId);
  }

  async function removeCustomReference(id, referenceId, userId) {
    const reference = await customStyles.findReferenceOwned(referenceId, id, userId);
    if (!reference) throw new AppError('REFERENCE_NOT_FOUND', 'Style reference not found', { status: 404 });
    await blobStore.delete(reference.storageKey);
    await customStyles.removeReference(referenceId, id, userId);
    return resolveReferences(id, userId);
  }

  async function reorderCustomReferences(id, category, ids, userId) {
    await customStyles.reorderReferences(id, userId, normalizeType(category), ids);
    return resolveReferences(id, userId);
  }

  async function customReference(id, referenceId, userId) {
    if (!customStyles || !userId) return null;
    return customStyles.findReferenceOwned(referenceId, id, userId);
  }

  async function customReferenceStream(id, referenceId, userId) {
    const reference = await customReference(id, referenceId, userId);
    if (!reference) throw new AppError('REFERENCE_NOT_FOUND', 'Style reference not found', { status: 404 });
    return { reference, stream: await blobStore.getStream(reference.storageKey) };
  }

  async function generateCustomReference(id, category, providerName, userId, { imageProvider, idempotencyKey }) {
    if (!customStyles || !blobStore || !userId) throw new AppError('UNAUTHENTICATED', 'Not authenticated', { status: 401 });
    const style = await customStyles.findOwned(id, userId, { includeArchived: false });
    if (!style) throw new AppError('STYLE_NOT_FOUND', 'Unknown style', { status: 404 });

    const normalized = normalizeType(category);

    // 0. Self-healing: Clean stale pending references before limit checks
    await customStyles.cleanStalePendingReferences(id);

    // 1. Check idempotency key before reserving/generating
    if (idempotencyKey) {
      const existingRef = await customStyles.findReferenceByIdempotencyKey(id, normalized, idempotencyKey);
      if (existingRef) {
        if (existingRef.status === 'active') {
          return resolveReferences(id, userId);
        }
        if (existingRef.status === 'pending') {
          throw new AppError('DUPLICATE_REQUEST', 'A reference generation is already in progress for this request', { status: 409 });
        }
        await customStyles.removeReference(existingRef.id, id, userId).catch(() => {});
      }
    }

    // 2. Enforce strict slot allocations in [0, 1, 2, 3] to prevent concurrency overlaps
    const existingRefs = await customStyles.listReferences(id, userId);
    // Find all occupied slots (pending or active)
    const occupiedSlots = existingRefs
      .filter((item) => item.category === normalized && item.status !== 'failed')
      .map((item) => item.sortOrder);
      
    const availableSlots = [0, 1, 2, 3].filter((slot) => !occupiedSlots.includes(slot));
    if (availableSlots.length === 0) {
      throw new AppError('REFERENCE_LIMIT', `A custom style can have at most 4 ${normalized} references`, { status: 400 });
    }
    const targetSortOrder = availableSlots[0];

    // Create the PENDING reference row to lock the slot
    const referenceId = crypto.randomUUID();
    await customStyles.addReference(id, userId, {
      id: referenceId,
      category: normalized,
      fileName: 'generating',
      storageKey: `pending-${referenceId}`,
      mimeType: 'image/png',
      byteSize: 0,
      sortOrder: targetSortOrder,
      status: 'pending',
      idempotencyKey: idempotencyKey || null,
      source: 'ai_generated',
    });

    // 3. Select explicit aspect ratios: 3:4 (portrait) for characters, 16:9 (landscape) for world
    const models = {
      stub: 'stub-image-v1',
      openai: config.env?.OPENAI_IMAGE_MODEL || 'gpt-image-1',
      gemini: config.env?.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image',
      ...(isDezgoProvider(providerName) ? { [providerName]: dezgoModelForProvider(providerName) } : {}),
    };
    
    const overrideAspect = normalized === 'world' ? '16:9' : '3:4';
    
    const output = resolveImageOutput({
      provider: providerName,
      model: models[providerName],
      intent: mergeMediaIntent({
        modality: 'image',
        platform: config.mediaOutputDefaults || undefined,
        project: null,
        override: { aspectRatio: overrideAspect },
      }),
    });

    let result;
    try {
      let suffix = '';
      if (normalized === 'characters') {
        suffix = `${style.title} character style exemplar. A single main character design, full body standing pose, front view, side view, back view, clean simple solid light background, character style reference sheet.`;
      } else {
        suffix = `${style.title} world design exemplar. A wide angle landscape establishing shot, clean environmental style, scenery detail, background setting reference, architectural layout and color palette key.`;
      }
      const prompt = [style.promptText, suffix].filter(Boolean).join('\n\n');

      result = await imageProvider.generate({
        provider: providerName,
        prompt,
        title: `Style Reference: ${style.title}`,
        output,
      });
    } catch (genError) {
      await customStyles.removeReference(referenceId, id, userId).catch(() => {});
      throw genError;
    }

    const fileName = `${referenceId}.${result.output.extension}`;
    const storageKey = buildCustomStyleReferenceStorageKey(userId, id, fileName);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-style-reference-'));
    const staged = path.join(tempDir, fileName);
    fs.writeFileSync(staged, result.output.buffer);
    
    try {
      await blobStore.put(storageKey, staged, { mimeType: result.output.mimeType, byteSize: result.output.buffer.length });
      
      await customStyles.updateReference(referenceId, id, userId, {
        status: 'active',
        fileName: `generated-${normalized}-${Date.now()}.${result.output.extension}`,
        storageKey,
        mimeType: result.output.mimeType,
        byteSize: result.output.buffer.length,
        promptSnapshot: style.promptText || '',
        provider: providerName,
        model: result.model || models[providerName],
        aspectRatio: overrideAspect,
        generationRequestId: result.generationRequestId || null,
      });
    } catch (storageError) {
      await blobStore.delete(storageKey).catch(() => {});
      // Mark reference as failed (durable record) so it preserves the generation attempt but releases the slot
      await customStyles.updateReference(referenceId, id, userId, { status: 'failed' }).catch(() => {});
      throw storageError;
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    return resolveReferences(id, userId);
  }

  return {
    find, list, listAvailable, listCustom, resolve, normalizeType, referenceDir, userReferenceDir, referenceFiles,
    referencePaths, referenceSources, resolveReferenceSources, references, resolveReferences,
    remove, activate, sanitize, upload, createCustom, updateCustom, archiveCustom,
    uploadCustomReferences, removeCustomReference, reorderCustomReferences, customReference, customReferenceStream,
    generateCustomReference,
  };
}

module.exports = { createStylesService };
