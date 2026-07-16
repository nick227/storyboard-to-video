const fs = require('node:fs');
const path = require('node:path');

function createAssetResolver(baseDir, publicPrefix) {
  const root = path.resolve(baseDir);
  return function resolveAsset(publicPath) {
    if (typeof publicPath !== 'string' || !publicPath.startsWith(`${publicPrefix}/`)) return null;
    let relative;
    try { relative = decodeURIComponent(publicPath.slice(publicPrefix.length + 1)); } catch (_) { return null; }
    if (!relative || relative.includes('\\') || relative !== path.basename(relative)) return null;
    const sourcePath = path.resolve(root, relative);
    if (sourcePath !== root && !sourcePath.startsWith(`${root}${path.sep}`)) return null;
    if (path.basename(sourcePath) !== path.basename(relative)) return null;
    return { fileName: path.basename(sourcePath), sourcePath };
  };
}

function removeAsset(resolver, publicPath) {
  const asset = resolver(publicPath);
  if (!asset) return false;
  fs.rmSync(asset.sourcePath, { force: true });
  return true;
}

module.exports = { createAssetResolver, removeAsset };
