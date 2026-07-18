const fs = require('node:fs');
const path = require('node:path');
const { slugify } = require('../shared/text');
const { detectImageExtension } = require('../media/image-format');
const { AppError } = require('../errors');

function createStylesService(config) {
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
  function list(userId) {
    return fs.readdirSync(config.paths.styles).filter((file) => file.endsWith('.md')).map((file) => {
      const content = fs.readFileSync(path.join(config.paths.styles, file), 'utf8').trim(); const id = file.replace(/\.md$/, '');
      return { id, name: content.split('\n')[0].replace(/^#\s*/, '').trim() || id, promptText: content.replace(/^#.+\n?/, '').trim(), file, references: references(id, userId) };
    });
  }
  const find = (id, userId) => list(userId).find((style) => style.id === id) || null;
  const referenceSources = (id, userId) => [...referenceFiles(id, 'characters', userId).slice(0, 4), ...referenceFiles(id, 'world', userId).slice(0, 4)].slice(0, 8);
  const referencePaths = (id, userId) => referenceSources(id, userId).map((item) => item.path);
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
  return { find, list, normalizeType, referenceDir, userReferenceDir, referenceFiles, referencePaths, referenceSources, references, remove, activate, sanitize, upload };
}

module.exports = { createStylesService };
