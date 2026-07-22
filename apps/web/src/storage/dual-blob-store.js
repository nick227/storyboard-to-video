/**
 * Dual-write policy: local is the read source; R2 is mirrored on put/delete.
 * R2 write failures after a successful local put are logged and do not fail the commit.
 */
function createDualBlobStore({ local, remote, onRemoteError = console.error }) {
  return {
    backend: 'dual',

    async put(storageKey, sourcePath, options = {}) {
      await local.put(storageKey, sourcePath, options);
      try {
        await remote.put(storageKey, sourcePath, { ...options, overwrite: true });
      } catch (error) {
        onRemoteError(`[dual-blob-store] R2 put failed for ${storageKey}:`, error);
      }
      return { storageKey };
    },

    async getStream(storageKey) {
      return local.getStream(storageKey);
    },

    async delete(storageKey) {
      await local.delete(storageKey);
      try {
        await remote.delete(storageKey);
      } catch (error) {
        onRemoteError(`[dual-blob-store] R2 delete failed for ${storageKey}:`, error);
      }
    },

    async exists(storageKey) {
      return local.exists(storageKey);
    },

    resolveLocalPath(storageKey) {
      return local.resolveLocalPath(storageKey);
    },
  };
}

module.exports = { createDualBlobStore };
