export const loadedAssets = new Map();
const pendingAssetLoads = new Map();
let assetCacheEpoch = 0;

async function requestProtectedAssetBlob(path, options = {}) {
  const res = await fetch(path, { signal: options.signal });

  if (!res.ok) {
    if (res.status === 401) {
      window.dispatchEvent(new CustomEvent('storyboard:unauthenticated'));
    }
    const error = new Error(`Failed to load asset: ${res.status}`);
    error.status = res.status;
    throw error;
  }

  return res.blob();
}

/**
 * Loads an authenticated asset as a Blob for upload/copy workflows.
 * Reuses the protected display cache when possible.
 */
export async function loadProtectedAssetBlob(path, options = {}) {
  if (!path) return null;
  const cachedUrl = loadedAssets.get(path);
  if (cachedUrl) {
    const cachedResponse = await fetch(cachedUrl, { signal: options.signal });
    if (!cachedResponse.ok) throw new Error(`Failed to read cached asset: ${cachedResponse.status}`);
    return cachedResponse.blob();
  }
  return requestProtectedAssetBlob(path, options);
}

function waitForAsset(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException('Asset load aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Asset load aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * Loads an authenticated asset and returns a blob URL.
 * Automatically revokes old URLs if re-fetching the same path.
 */
export async function loadProtectedAsset(path, options = {}) {
  if (!path) return null;
  if (loadedAssets.has(path)) return loadedAssets.get(path);
  if (pendingAssetLoads.has(path)) return waitForAsset(pendingAssetLoads.get(path), options.signal);

  const epoch = assetCacheEpoch;
  const pending = (async () => {
    try {
      // The shared request is not owned by any one caller's AbortSignal. Each caller can stop
      // waiting independently while another component continues to use the same in-flight load.
      const blob = await loadProtectedAssetBlob(path);
      if (epoch !== assetCacheEpoch) return null;
      const url = URL.createObjectURL(blob);
      loadedAssets.set(path, url);
      return url;
    } catch (error) {
      if (error.status === 401) return path;
      throw error;
    } finally {
      if (pendingAssetLoads.get(path) === pending) pendingAssetLoads.delete(path);
    }
  })();
  pendingAssetLoads.set(path, pending);
  return waitForAsset(pending, options.signal);
}

/**
 * Revokes every cached blob URL and clears the cache. Call this when leaving
 * a project so assets from the old project don't stay pinned in memory.
 */
export function revokeAllAssets() {
  assetCacheEpoch++;
  loadedAssets.forEach((url) => URL.revokeObjectURL(url));
  loadedAssets.clear();
  pendingAssetLoads.clear();
}

/**
 * Downloads a protected URL as a file.
 */
export async function downloadProtectedUrl(path, filename = '') {
  try {
    const url = await loadProtectedAsset(path);
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  } catch (error) {
    if (error.name !== 'AbortError') console.error('Error downloading protected asset:', error);
  }
}
