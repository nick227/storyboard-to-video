const pixabay = require('./pixabay');
const { AppError } = require('../../errors');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // Pixabay API terms require caching results for 24h.
const CACHE_MAX_ENTRIES = 500;

// mediaType|sfx and |music are part of the shared interface today so a second provider (Freesound,
// Jamendo) can be added later without reshaping this module -- only pixabay/image+video are wired up.
const PROVIDER_MEDIA_TYPES = { pixabay: new Set(['image', 'video']) };

function cacheKey({ provider, mediaType, query, page, perPage }) {
  return `${provider}:${mediaType}:${String(query).trim().toLowerCase()}:${page}:${perPage}`;
}

function createSearchCache() {
  const store = new Map();
  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) { store.delete(key); return null; }
      return entry.value;
    },
    set(key, value) {
      if (store.size >= CACHE_MAX_ENTRIES) store.delete(store.keys().next().value);
      store.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    },
  };
}

function createStockProviders(config, providerAdmission) {
  const cache = createSearchCache();

  async function pixabaySearch({ mediaType, query, page, perPage, signal }) {
    if (!config.env.PIXABAY_API_KEY) throw new Error('PIXABAY_API_KEY missing');
    const operation = () => pixabay.search({ apiKey: config.env.PIXABAY_API_KEY, mediaType, query, page, perPage, signal });
    return providerAdmission ? providerAdmission.run('pixabay', operation, { signal }) : operation();
  }

  async function search({ provider = 'pixabay', mediaType, query, page = 1, perPage = 20, signal }) {
    const trimmedQuery = String(query || '').trim();
    if (!trimmedQuery) throw new AppError('VALIDATION_ERROR', 'A search query is required', { status: 400 });
    const supported = PROVIDER_MEDIA_TYPES[provider];
    if (!supported) throw new AppError('VALIDATION_ERROR', `Unknown stock provider: ${provider}`, { status: 400 });
    if (!supported.has(mediaType)) throw new AppError('VALIDATION_ERROR', `${provider} does not support media type: ${mediaType}`, { status: 400 });

    const key = cacheKey({ provider, mediaType, query: trimmedQuery, page, perPage });
    const cached = cache.get(key);
    if (cached) return cached;

    const result = provider === 'pixabay'
      ? await pixabaySearch({ mediaType, query: trimmedQuery, page, perPage, signal })
      : (() => { throw new AppError('VALIDATION_ERROR', `Unknown stock provider: ${provider}`, { status: 400 }); })();

    cache.set(key, result);
    return result;
  }

  return { search, capabilities: PROVIDER_MEDIA_TYPES };
}

module.exports = { createStockProviders };
