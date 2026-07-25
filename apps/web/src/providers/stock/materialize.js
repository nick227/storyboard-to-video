const { AppError } = require('../../errors');

const STOCK_IMAGE_CONTENT_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const STOCK_IMAGE_MAX_BYTES = 15 * 1024 * 1024;

// Only pixabay.com/cdn.pixabay.com URLs may be fetched server-side -- the URL passed in here
// otherwise comes straight from request input (the route) or a provider's own search response (the
// image-provider path), so without this allowlist a crafted fullUrl would let a caller make the
// server fetch arbitrary internal/external addresses (SSRF).
function assertPixabayAssetUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(String(rawUrl)); } catch (_) { throw new AppError('VALIDATION_ERROR', 'Invalid stock asset URL', { status: 400 }); }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || !(host === 'pixabay.com' || host.endsWith('.pixabay.com'))) {
    throw new AppError('VALIDATION_ERROR', 'Stock asset URL is not from a supported provider', { status: 400 });
  }
  return parsed;
}

// Shared by POST /stock/select (user-picked from the browse UI) and the pixabay image-provider
// path (auto-picked for batch/individual generation) -- same download, same validation, one place
// to get the security-sensitive parts (redirect handling, content type, size) right.
async function downloadStockImage(rawUrl, { signal } = {}) {
  const parsedUrl = assertPixabayAssetUrl(rawUrl);

  // redirect: 'manual' -- a redirect off pixabay.com (compromised CDN, crafted response, etc.) must
  // not be silently followed, since that would let the allowlist above be bypassed after the fact.
  const response = await fetch(parsedUrl, { redirect: 'manual', signal });
  if (response.status >= 300 && response.status < 400) {
    throw new AppError('PROVIDER_ERROR', 'Stock asset URL redirected; refusing to follow off the allowed host', { status: 502 });
  }
  if (!response.ok) throw new AppError('PROVIDER_ERROR', `Failed to download stock image (${response.status})`, { status: 502 });

  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const extension = STOCK_IMAGE_CONTENT_TYPES[contentType];
  if (!extension) throw new AppError('PROVIDER_ERROR', `Unexpected content type from stock provider: ${contentType || 'unknown'}`, { status: 502 });

  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > STOCK_IMAGE_MAX_BYTES) {
    throw new AppError('PROVIDER_ERROR', 'Stock image exceeds the maximum allowed size', { status: 502 });
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > STOCK_IMAGE_MAX_BYTES) {
    throw new AppError('PROVIDER_ERROR', 'Stock image exceeds the maximum allowed size', { status: 502 });
  }

  return { buffer, mimeType: contentType, extension };
}

module.exports = { assertPixabayAssetUrl, downloadStockImage, STOCK_IMAGE_MAX_BYTES };
