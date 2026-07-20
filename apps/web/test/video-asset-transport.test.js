const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  encodeLocalFileToBase64DataUri,
  createStagedAssetAdapter,
  validatePathSafety,
  downloadRemoteVideo,
} = require('../src/providers/video/asset-transport');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transport-test-'));
  const sampleImage = path.join(root, 'sample.png');
  fs.writeFileSync(sampleImage, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return {
    root,
    sampleImage,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('encodeLocalFileToBase64DataUri converts image to base64 data URI', () => {
  const f = fixture();
  try {
    const dataUri = encodeLocalFileToBase64DataUri(f.sampleImage);
    assert.match(dataUri, /^data:image\/png;base64,/);
    const raw = encodeLocalFileToBase64DataUri(f.sampleImage, { dataUri: false });
    assert.doesNotMatch(raw, /^data:/);
  } finally {
    f.cleanup();
  }
});

test('encodeLocalFileToBase64DataUri throws FILE_NOT_FOUND when file does not exist', () => {
  assert.throws(() => encodeLocalFileToBase64DataUri('/nonexistent/file.png'), (error) => {
    assert.equal(error.code, 'FILE_NOT_FOUND');
    return true;
  });
});

test('encodeLocalFileToBase64DataUri throws PAYLOAD_TOO_LARGE when size exceeds limit', () => {
  const f = fixture();
  try {
    assert.throws(
      () => encodeLocalFileToBase64DataUri(f.sampleImage, { maxSizeBytes: 2 }),
      (error) => {
        assert.equal(error.code, 'PAYLOAD_TOO_LARGE');
        return true;
      }
    );
  } finally {
    f.cleanup();
  }
});

test('createStagedAssetAdapter supports inline_base64 and public_url strategies', async () => {
  const f = fixture();
  try {
    const inlineAdapter = createStagedAssetAdapter({ strategy: 'inline_base64' });
    const inlineResult = await inlineAdapter.stageAsset(f.sampleImage);
    assert.equal(inlineResult.strategy, 'inline_base64');
    assert.match(inlineResult.url, /^data:image\/png;base64,/);

    const publicAdapter = createStagedAssetAdapter({ strategy: 'public_url', publicAppUrl: 'http://localhost:3000', root: f.root });
    const publicResult = await publicAdapter.stageAsset(f.sampleImage);
    assert.equal(publicResult.strategy, 'public_url');
    assert.equal(publicResult.url, 'http://localhost:3000/sample.png');
  } finally {
    f.cleanup();
  }
});

test('validatePathSafety prevents directory traversal outside allowed directories', () => {
  const allowed = [path.resolve('/tmp/allowed-dir')];
  const safePath = path.resolve('/tmp/allowed-dir/file.mp4');
  assert.equal(validatePathSafety(safePath, { allowedDirs: allowed }), safePath);

  const unsafePath = path.resolve('/tmp/allowed-dir/../../etc/passwd');
  assert.throws(() => validatePathSafety(unsafePath, { allowedDirs: allowed }), (error) => {
    assert.equal(error.code, 'UNSAFE_PATH');
    return true;
  });
});

test('downloadRemoteVideo streams video content atomically and validates HTTP status', async () => {
  const f = fixture();
  try {
    const videoData = Buffer.from('FAKE-MP4-VIDEO-CONTENT-STREAM');
    const mockFetch = async (url) => {
      if (url.includes('404')) return new Response('Not Found', { status: 404 });
      return new Response(videoData, { status: 200, headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(videoData.length) } });
    };

    const targetPath = path.join(f.root, 'output.mp4');
    const result = await downloadRemoteVideo('http://example.com/video.mp4', targetPath, { fetch: mockFetch });

    assert.equal(result.outputPath, targetPath);
    assert.equal(fs.existsSync(targetPath), true);
    assert.equal(fs.readFileSync(targetPath, 'utf8'), 'FAKE-MP4-VIDEO-CONTENT-STREAM');

    await assert.rejects(
      downloadRemoteVideo('http://example.com/404.mp4', path.join(f.root, 'fail.mp4'), { fetch: mockFetch }),
      (error) => {
        assert.equal(error.code, 'DOWNLOAD_FAILED');
        return true;
      }
    );
  } finally {
    f.cleanup();
  }
});

test('downloadRemoteVideo cleans up temp files when size limit is breached or request is cancelled', async () => {
  const f = fixture();
  try {
    const largeChunk = Buffer.alloc(1024 * 1024);
    const mockFetch = async () => new Response(largeChunk, { status: 200, headers: { 'Content-Type': 'video/mp4' } });

    const targetPath = path.join(f.root, 'too-large.mp4');
    await assert.rejects(
      downloadRemoteVideo('http://example.com/video.mp4', targetPath, { fetch: mockFetch, maxSizeBytes: 500 }),
      (error) => {
        assert.equal(error.code, 'PAYLOAD_TOO_LARGE');
        return true;
      }
    );

    const tempFiles = fs.readdirSync(f.root).filter((file) => file.includes('.tmp.'));
    assert.equal(tempFiles.length, 0);
  } finally {
    f.cleanup();
  }
});
