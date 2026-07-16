function copyIntoProject(store, lease, type, sourcePath, signal) {
  if (!lease) return null;
  return store.commitAsset(lease, type, sourcePath, { signal }).path;
}

module.exports = { copyIntoProject };
