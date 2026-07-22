async function copyIntoProject(store, lease, type, sourcePath, signal) {
  if (!lease) return null;
  const asset = await store.commitAsset(lease, type, sourcePath, { signal });
  return asset.path;
}

module.exports = { copyIntoProject };
