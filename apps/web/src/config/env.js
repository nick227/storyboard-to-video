const path = require('node:path');
const { PIPER_VOICE_CATALOG } = require('./piper-voices');

function integer(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function loadConfig(root = path.resolve(__dirname, '../..')) {
  const env = process.env;
  const paths = {
    root,
    public: path.join(root, 'public'), styles: path.join(root, 'styles'), styleReferences: path.join(root, 'style-references'),
    generated: path.join(root, 'data', 'generated'), audio: path.join(root, 'data', 'audio'), videos: path.join(root, 'data', 'videos'),
    stubs: path.join(root, 'data', 'stubs'), zips: path.join(root, 'data', 'zips'), projects: path.join(root, 'data', 'projects'),
    jobs: path.join(root, 'data', 'jobs'), idempotency: path.join(root, 'data', 'idempotency'),
    piper: env.PIPER_BINARY_PATH || path.join(root, 'vendor', 'piper', 'piper'),
    piperVoices: path.join(root, 'vendor', 'piper', 'voices'),
    ltxShared: path.resolve(env.LTX_SHARED_DIR || '/home/administrator/web/ltx-env/io/basic-cartoon-poc'),
  };
  return {
    port: integer(env.PORT, 3000, 1, 65535), paths,
    limits: { references: 8, referenceBytes: 8 * 1024 * 1024, script: 200_000, prompt: 20_000, line: 2_000, json: '10mb' },
    generationConcurrency: integer(env.GENERATION_CONCURRENCY, 1, 1, 32),
    sparkUrl: String(env.SPARK_TTS_URL || 'http://localhost:8001').replace(/\/+$/, ''), sparkTimeout: integer(env.SPARK_TTS_TIMEOUT_MS, 120_000, 1, 600_000), sparkServiceToken: String(env.SPARK_SERVICE_TOKEN || ''),
    ltxUrl: String(env.LTX_VIDEO_URL || 'http://localhost:8000').replace(/\/+$/, ''), videoProvider: env.VIDEO_PROVIDER === 'stub' ? 'stub' : 'ltx',
    piperVoices: String(env.PIPER_VOICE_IDS || PIPER_VOICE_CATALOG.map((v) => v.id).join(',')).split(',').map((x) => x.trim()).filter(Boolean),
    audio: { sampleRate: 24_000, channels: 1, bits: 16, gapMs: 250 }, env,
  };
}

module.exports = { integer, loadConfig };
