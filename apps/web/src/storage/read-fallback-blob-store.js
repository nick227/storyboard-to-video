/**
 * Read policy for R2-primary deployments with legacy local bytes:
 * put/delete target primary; getStream/exists try primary first, then fallback.
 */
function createReadFallbackBlobStore({ primary, fallback, onFallbackError = console.error }) {
  return {
    backend: primary.backend,

    async put(storageKey, sourcePath, options = {}) {
      return primary.put(storageKey, sourcePath, options);
    },

    async getStream(storageKey) {
      if (await primary.exists(storageKey)) return primary.getStream(storageKey);
      return fallback.getStream(storageKey);
    },

    async delete(storageKey) {
      await primary.delete(storageKey);
      try {
        await fallback.delete(storageKey);
      } catch (error) {
        onFallbackError(`[read-fallback-blob-store] fallback delete failed for ${storageKey}:`, error);
      }
    },

    async exists(storageKey) {
      if (await primary.exists(storageKey)) return true;
      return fallback.exists(storageKey);
    },

    resolveLocalPath(storageKey) {
      return fallback.resolveLocalPath?.(storageKey) ?? null;
    },
  };
}

module.exports = { createReadFallbackBlobStore };
