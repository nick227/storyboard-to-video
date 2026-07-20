const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { createMiniMaxAdapter } = require('../src/providers/video/minimax');
const { videoProviderCapabilities } = require('../src/shared/video-provider-capabilities');

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makePng(width, height) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const ihdrChunk = createChunk('IHDR', ihdr);

  const scanline = Buffer.alloc(1 + width * 3);
  scanline[0] = 0; // filter 0
  for (let x = 0; x < width; x++) {
    scanline[1 + x * 3] = 64;   // R
    scanline[1 + x * 3 + 1] = 128; // G
    scanline[1 + x * 3 + 2] = 200; // B
  }

  const rawData = Buffer.concat(Array(height).fill(scanline));
  const compressedData = zlib.deflateSync(rawData);
  const idatChunk = createChunk('IDAT', compressedData);

  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function createChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const payload = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(payload), 0);
  return Buffer.concat([len, payload, crcBuf]);
}

async function runSmokeTest() {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    console.log('SKIPPED: MINIMAX_API_KEY environment variable is missing.');
    console.log('Provide MINIMAX_API_KEY to run the live smoke test.');
    process.exit(0);
  }

  console.log('1. Checking capabilities for MiniMax video-01...');
  const caps = videoProviderCapabilities('minimax', 'video-01', 'image_to_video');
  console.log('Capabilities resolved:', caps);

  const adapter = createMiniMaxAdapter({ env: process.env });
  console.log('2. Verifying MiniMax provider status...');
  const verifyRes = await adapter.verify({ model: 'video-01', mode: 'image_to_video' });
  console.log('Verify response:', verifyRes);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-smoke-'));
  const testImagePath = path.join(tmpDir, 'test-frame.png');
  const outputPath = path.join(tmpDir, 'smoke-result.mp4');

  // Create valid 512x512 test image (MiniMax requires min 300px short side)
  const samplePngBuffer = makePng(512, 512);
  fs.writeFileSync(testImagePath, samplePngBuffer);

  const request = {
    model: 'video-01',
    generationMode: 'image_to_video',
    prompt: 'A gentle ripple across quiet blue water, high quality 4k render',
    preparedInputs: [{ role: 'start_frame', assetPath: testImagePath }],
    outputPath,
  };

  console.log('3. Submitting task to MiniMax API with 512x512 reference frame...');
  const submitRes = await adapter.submit(request);
  console.log('Task submitted successfully:', submitRes);

  console.log(`4. Polling task status for providerTaskId: ${submitRes.providerTaskId}...`);
  let task = submitRes;
  let attempts = 0;
  while (task.state !== 'completed' && task.state !== 'failed' && attempts < 60) {
    attempts++;
    await new Promise((resolve) => setTimeout(resolve, 5000));
    task = await adapter.inspect(task);
    console.log(`[Attempt ${attempts}] Task state: ${task.state}`);
  }

  if (task.state !== 'completed') {
    console.error('FAILED: MiniMax task failed or timed out:', task);
    process.exit(1);
  }

  console.log('5. Fetching generated video result...');
  const result = await adapter.fetchResult(task);
  console.log('Fetch result:', result);

  if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
    console.log(`SUCCESS: Video saved to ${outputPath} (${fs.statSync(outputPath).size} bytes)`);
  } else {
    console.error('FAILED: Output file was not saved properly.');
    process.exit(1);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

runSmokeTest().catch((err) => {
  console.error('ERROR during smoke test:', err);
  process.exit(1);
});
