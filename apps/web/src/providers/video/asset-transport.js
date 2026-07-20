const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { AppError } = require('../../errors');
const { signal } = require('../http');

const DEFAULT_BASE64_MAX_BYTES = 10 * 1024 * 1024; // 10MB
const DEFAULT_DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024; // 200MB
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 300_000; // 5 minutes

function mimeTypeFromExtension(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'mp4':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
    default:
      return 'image/png';
  }
}

function encodeLocalFileToBase64DataUri(filePath, options = {}) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new AppError('FILE_NOT_FOUND', `File does not exist for base64 encoding: ${filePath}`, { status: 400 });
  }

  const maxBytes = options.maxSizeBytes || DEFAULT_BASE64_MAX_BYTES;
  const stat = fs.statSync(resolved);
  if (stat.size > maxBytes) {
    throw new AppError('PAYLOAD_TOO_LARGE', `File size (${stat.size} bytes) exceeds base64 limit (${maxBytes} bytes)`, { status: 400 });
  }

  const buffer = fs.readFileSync(resolved);
  const mimeType = options.mimeType || mimeTypeFromExtension(resolved);
  const base64 = buffer.toString('base64');

  if (options.dataUri === false) {
    return base64;
  }
  return `data:${mimeType};base64,${base64}`;
}

function createStagedAssetAdapter(options = {}) {
  if (typeof options.stageAsset === 'function') {
    return { stageAsset: options.stageAsset };
  }

  const strategy = options.strategy || 'inline_base64';

  return {
    async stageAsset(filePath, metadata = {}) {
      const resolved = path.resolve(filePath);
      if (!fs.existsSync(resolved)) {
        throw new AppError('FILE_NOT_FOUND', `Local asset not found for staging: ${filePath}`, { status: 400 });
      }

      if (strategy === 'public_url') {
        if (!options.publicAppUrl) {
          throw new AppError('STAGING_FAILED', 'publicAppUrl is required for public_url staging strategy', { status: 500 });
        }
        const rel = path.relative(options.root || process.cwd(), resolved).replace(/\\/g, '/');
        const url = `${options.publicAppUrl.replace(/\/+$/, '')}/${rel}`;
        return { url, strategy: 'public_url', expiresAt: null };
      }

      // Default strategy: inline_base64
      const url = encodeLocalFileToBase64DataUri(resolved, options);
      return { url, strategy: 'inline_base64', expiresAt: null };
    },
  };
}

function validatePathSafety(targetPath, options = {}) {
  if (!targetPath || typeof targetPath !== 'string') {
    throw new AppError('INVALID_PATH', 'Target path must be a non-empty string', { status: 400 });
  }
  const resolved = path.resolve(targetPath);

  if (options.allowedDirs && Array.isArray(options.allowedDirs) && options.allowedDirs.length > 0) {
    const isAllowed = options.allowedDirs.some((dir) => {
      const resolvedDir = path.resolve(dir);
      return resolved.startsWith(resolvedDir + path.sep) || resolved === resolvedDir;
    });
    if (!isAllowed) {
      throw new AppError('UNSAFE_PATH', `Target path is outside allowed directories: ${targetPath}`, { status: 403 });
    }
  }

  return resolved;
}

async function downloadRemoteVideo(url, targetPath, options = {}) {
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new AppError('INVALID_URL', `Invalid video download URL: ${url}`, { status: 400 });
  }

  const resolvedPath = validatePathSafety(targetPath, options);
  const timeoutMs = options.timeoutMs || DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const maxBytes = options.maxSizeBytes || DEFAULT_DOWNLOAD_MAX_BYTES;
  const fetchImpl = options.fetch || globalThis.fetch;

  if (typeof fetchImpl !== 'function') {
    throw new AppError('FETCH_UNAVAILABLE', 'Fetch function is required for downloading remote video', { status: 500 });
  }

  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const tempPath = `${resolvedPath}.tmp.${crypto.randomBytes(6).toString('hex')}`;
  const combinedSignal = signal(timeoutMs, options.getCancellation);

  let tempCreated = false;

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'video/mp4, video/*, */*',
        ...(options.headers || {}),
      },
      signal: combinedSignal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new AppError('DOWNLOAD_FAILED', `Remote video server returned HTTP ${response.status}: ${text.slice(0, 300)}`, {
        status: response.status >= 400 && response.status < 500 ? response.status : 502,
        retryable: response.status >= 500 || response.status === 429,
      });
    }

    const contentLengthHeader = response.headers?.get('content-length');
    if (contentLengthHeader) {
      const contentLength = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new AppError('PAYLOAD_TOO_LARGE', `Remote video size (${contentLength} bytes) exceeds limit (${maxBytes} bytes)`, { status: 413, retryable: false });
      }
    }

    if (!response.body) {
      throw new AppError('EMPTY_RESPONSE', 'Remote video response contains no body stream', { status: 502 });
    }

    const nodeStream = typeof response.body.getReader === 'function' ? Readable.fromWeb(response.body) : response.body;

    let bytesDownloaded = 0;
    const writeStream = fs.createWriteStream(tempPath);
    tempCreated = true;

    nodeStream.on('data', (chunk) => {
      bytesDownloaded += chunk.length;
      if (bytesDownloaded > maxBytes) {
        nodeStream.destroy(new AppError('PAYLOAD_TOO_LARGE', `Downloaded video bytes exceeded limit (${maxBytes} bytes)`, { status: 413, retryable: false }));
      }
    });

    await pipeline(nodeStream, writeStream);

    const stat = fs.statSync(tempPath);
    if (stat.size === 0) {
      throw new AppError('EMPTY_FILE', 'Downloaded video file is 0 bytes', { status: 502 });
    }

    // Atomic finalize
    try {
      fs.renameSync(tempPath, resolvedPath);
    } catch (_) {
      fs.copyFileSync(tempPath, resolvedPath);
      fs.unlinkSync(tempPath);
    }
    tempCreated = false;

    return {
      outputPath: resolvedPath,
      bytes: stat.size,
      mimeType: response.headers?.get('content-type') || 'video/mp4',
    };
  } catch (error) {
    if (tempCreated && fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch (_) {}
    }

    if (error instanceof AppError) {
      throw error;
    }

    if (error.name === 'AbortError' || combinedSignal.aborted) {
      throw new AppError('DOWNLOAD_CANCELLED', `Remote video download cancelled or timed out after ${timeoutMs}ms`, { status: 408, retryable: true, cause: error });
    }

    throw new AppError('DOWNLOAD_FAILED', `Failed to download remote video: ${error.message}`, { status: 502, retryable: true, cause: error });
  }
}

function createLocalVideoAssetTransport(options = {}) {
  return {
    async prepareInput(input) {
      return {
        ...input,
        transport: {
          type: 'local_file',
          path: input.sourcePath || input.assetPath,
        },
      };
    },
    async prepareOutput(request) {
      return {
        type: 'local_file',
        path: request.outputPath,
      };
    },
  };
}

module.exports = {
  DEFAULT_BASE64_MAX_BYTES,
  DEFAULT_DOWNLOAD_MAX_BYTES,
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  createLocalVideoAssetTransport,
  createStagedAssetAdapter,
  downloadRemoteVideo,
  encodeLocalFileToBase64DataUri,
  mimeTypeFromExtension,
  validatePathSafety,
};
