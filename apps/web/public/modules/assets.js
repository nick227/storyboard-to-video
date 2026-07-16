export const loadedAssets = new Map();

/**
 * Loads an authenticated asset and returns a blob URL.
 * Automatically revokes old URLs if re-fetching the same path.
 */
export async function loadProtectedAsset(path) {
  if (!path) return null;
  // Use existing cached blob URL if already loaded
  if (loadedAssets.has(path)) {
    return loadedAssets.get(path);
  }

  const token = localStorage.getItem('storyboard-auth-token') || 'local-dev-token';
  try {
    const res = await fetch(path, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (!res.ok) {
      if (res.status === 401) {
        // Just return path on 401, maybe the browser can handle it or we prompt via api.js
        return path;
      }
      throw new Error(`Failed to load asset: ${res.status}`);
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    loadedAssets.set(path, url);
    return url;
  } catch (error) {
    console.error('Error loading protected asset:', path, error);
    return path; // Fallback to raw path
  }
}

export function revokeAsset(path) {
  if (loadedAssets.has(path)) {
    URL.revokeObjectURL(loadedAssets.get(path));
    loadedAssets.delete(path);
  }
}

/**
 * Revokes every cached blob URL and clears the cache. Call this when leaving
 * a project so assets from the old project don't stay pinned in memory.
 */
export function revokeAllAssets() {
  loadedAssets.forEach((url) => URL.revokeObjectURL(url));
  loadedAssets.clear();
}

/**
 * Downloads a protected URL as a file.
 */
export async function downloadProtectedUrl(path, filename = '') {
  const url = await loadProtectedAsset(path);
  if (!url) return;
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
}
