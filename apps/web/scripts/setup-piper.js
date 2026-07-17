const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PIPER_VOICE_CATALOG, piperVoiceHfPaths } = require('../src/config/piper-voices');

const ROOT = path.join(__dirname, '..');
const VENDOR_DIR = path.join(ROOT, 'vendor');
const PIPER_DIR = path.join(VENDOR_DIR, 'piper');
const PIPER_BINARY = path.join(PIPER_DIR, 'piper');
const VOICES_DIR = path.join(PIPER_DIR, 'voices');

const PIPER_RELEASE_URL = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz';

const DEFAULT_VOICES = PIPER_VOICE_CATALOG.map(({ id }) => ({ id, ...piperVoiceHfPaths(id) }));

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function download(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
}

async function setupEngine() {
  if (fs.existsSync(PIPER_BINARY)) {
    console.log(`Piper engine already installed at ${PIPER_BINARY}`);
    return;
  }
  ensureDir(VENDOR_DIR);
  const tarPath = path.join(VENDOR_DIR, 'piper.tar.gz');
  console.log('Downloading Piper engine (~26 MB)...');
  await download(PIPER_RELEASE_URL, tarPath);
  console.log('Extracting...');
  execFileSync('tar', ['-xzf', tarPath, '-C', VENDOR_DIR]);
  fs.unlinkSync(tarPath);
  fs.chmodSync(PIPER_BINARY, 0o755);
  console.log(`Piper engine installed at ${PIPER_BINARY}`);
}

async function setupVoice(voice) {
  ensureDir(VOICES_DIR);
  const onnxPath = path.join(VOICES_DIR, `${voice.id}.onnx`);
  const configPath = path.join(VOICES_DIR, `${voice.id}.onnx.json`);
  if (fs.existsSync(onnxPath) && fs.existsSync(configPath)) {
    console.log(`Voice already installed: ${voice.id}`);
    return;
  }
  console.log(`Downloading voice "${voice.id}" (~60 MB)...`);
  await download(voice.onnxUrl, onnxPath);
  await download(voice.configUrl, configPath);
  console.log(`Voice installed: ${voice.id}`);
}

(async () => {
  try {
    await setupEngine();
    for (const voice of DEFAULT_VOICES) await setupVoice(voice);
    console.log('\nPiper is ready. Select "Piper (local, natural)" as the audio provider.');
  } catch (error) {
    console.error(`Piper setup failed: ${error.message}`);
    process.exitCode = 1;
  }
})();
