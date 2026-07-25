const { throwResponse } = require('../http');

const PIXABAY_IMAGE_ENDPOINT = 'https://pixabay.com/api/';
const PIXABAY_VIDEO_ENDPOINT = 'https://pixabay.com/api/videos/';
const LICENSE_URL = 'https://pixabay.com/service/license/';

// Pixabay content is free to use for commercial and noncommercial purposes with no attribution
// required -- unlike Freesound/Jamendo (planned next), there is no per-item license variance to model.
function licenseFields() {
  return {
    licenseCode: 'pixabay',
    licenseUrl: LICENSE_URL,
    attributionText: null,
    commercialUseAllowed: true,
  };
}

function normalizeImageHit(hit) {
  return {
    providerId: String(hit.id),
    provider: 'pixabay',
    mediaType: 'image',
    thumbnailUrl: hit.previewURL,
    previewUrl: hit.webformatURL,
    fullUrl: hit.largeImageURL,
    width: hit.imageWidth,
    height: hit.imageHeight,
    tags: hit.tags,
    creator: hit.user,
    sourcePageUrl: hit.pageURL,
    ...licenseFields(),
  };
}

function normalizeVideoHit(hit) {
  const variants = hit.videos || {};
  const preview = variants.small || variants.medium || variants.tiny;
  const full = variants.large || variants.medium || variants.small;
  return {
    providerId: String(hit.id),
    provider: 'pixabay',
    mediaType: 'video',
    thumbnailUrl: variants.tiny?.thumbnail || preview?.thumbnail || '',
    previewUrl: preview?.url,
    fullUrl: (full || preview)?.url,
    width: (full || preview)?.width,
    height: (full || preview)?.height,
    tags: hit.tags,
    creator: hit.user,
    sourcePageUrl: hit.pageURL,
    ...licenseFields(),
  };
}

async function search({ apiKey, mediaType, query, page = 1, perPage = 20, signal }) {
  if (!apiKey) throw new Error('PIXABAY_API_KEY missing');
  const isVideo = mediaType === 'video';
  const url = new URL(isVideo ? PIXABAY_VIDEO_ENDPOINT : PIXABAY_IMAGE_ENDPOINT);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('q', query);
  url.searchParams.set('page', String(Math.max(1, Number.parseInt(page, 10) || 1)));
  url.searchParams.set('per_page', String(Math.min(Math.max(Number.parseInt(perPage, 10) || 20, 3), 100)));
  url.searchParams.set('safesearch', 'true');

  const response = await fetch(url, { signal });
  if (!response.ok) await throwResponse('pixabay', response);
  const data = await response.json();
  const hits = Array.isArray(data.hits) ? data.hits : [];
  return {
    results: hits.map(isVideo ? normalizeVideoHit : normalizeImageHit),
    page: Number.parseInt(page, 10) || 1,
    totalHits: data.totalHits || 0,
    total: data.total || 0,
  };
}

module.exports = { search, LICENSE_URL };
