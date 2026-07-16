const fs = require('node:fs');
const path = require('node:path');
const { slugify } = require('../shared/text');
const { detectImageExtension } = require('../media/image-format');
const { AppError } = require('../errors');

function createStylesService(config) {
  const sanitize = (id = '') => slugify(id);
  const normalizeType = (type = '') => type === 'world' ? 'world' : 'characters';
  const referenceDir = (id, type) => path.join(config.paths.styleReferences, sanitize(id), normalizeType(type));
  const publicPath = (id, type, file) => `/style-references/${sanitize(id)}/${normalizeType(type)}/${encodeURIComponent(file)}`;
  function referenceFiles(id, type) {
    const dir = referenceDir(id, type); fs.mkdirSync(dir, { recursive: true });
    return fs.readdirSync(dir).filter((file) => /\.(png|jpe?g|webp|gif)$/i.test(file)).sort().map((fileName) => ({ fileName, path: path.join(dir, fileName), url: publicPath(id, type, fileName), type: normalizeType(type) }));
  }
  const references = (id) => ({ characters: referenceFiles(id, 'characters').map(publicRecord), world: referenceFiles(id, 'world').map(publicRecord) });
  function publicRecord({ fileName, url, type }) { return { fileName, url, type }; }
  function list() {
    return fs.readdirSync(config.paths.styles).filter((file) => file.endsWith('.md')).map((file) => {
      const content = fs.readFileSync(path.join(config.paths.styles, file), 'utf8').trim(); const id = file.replace(/\.md$/, '');
      return { id, name: content.split('\n')[0].replace(/^#\s*/, '').trim() || id, promptText: content.replace(/^#.+\n?/, '').trim(), file, references: references(id) };
    });
  }
  const find = (id) => list().find((style) => style.id === id) || null;
  const referencePaths = (id) => [...referenceFiles(id, 'characters').slice(0, 4), ...referenceFiles(id, 'world').slice(0, 4)].slice(0, 8).map((item) => item.path);
  function upload(id,type,files){if(!find(id))throw new AppError('STYLE_NOT_FOUND','Unknown style',{status:404});const normalized=normalizeType(type),existing=referenceFiles(id,normalized);if(!files?.length)throw new AppError('VALIDATION_ERROR','At least one image is required',{status:400});if(existing.length+files.length>8)throw new AppError('REFERENCE_LIMIT',`A style can have at most 8 ${normalized} references`,{status:400});const prepared=files.map((file)=>({file,extension:detectImageExtension(file.buffer)}));if(prepared.some((x)=>!x.extension))throw new AppError('INVALID_IMAGE','Only valid PNG, JPEG, WebP, and GIF images are accepted',{status:400});const dir=referenceDir(id,normalized);prepared.forEach(({file,extension},i)=>fs.writeFileSync(path.join(dir,`${Date.now()}-${i}-${slugify(path.basename(file.originalname,path.extname(file.originalname)))}.${extension}`),file.buffer));return references(id);}
  function remove(id,type,fileName){if(!find(id))throw new AppError('STYLE_NOT_FOUND','Unknown style',{status:404});const safe=path.basename(fileName||'');if(!safe||safe!==fileName)throw new AppError('INVALID_PATH','Invalid reference filename',{status:400});fs.rmSync(path.join(referenceDir(id,type),safe),{force:true});return references(id);}
  return { find, list, normalizeType, referenceDir, referenceFiles, referencePaths, references, remove, sanitize, upload };
}

module.exports = { createStylesService };
