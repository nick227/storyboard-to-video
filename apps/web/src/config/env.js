const path = require('node:path');
const { PIPER_VOICE_CATALOG } = require('./piper-voices');
const { PLATFORM_MEDIA_DEFAULTS } = require('../shared/media-output-policy');
const { VIDEO_PROVIDERS } = require('../shared/video-provider-capabilities');

function integer(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function enabled(value) { return String(value || '').toLowerCase() === 'true'; }

function loadConfig(root = path.resolve(__dirname, '../..')) {
  const env = process.env;
  const paths = {
    root,
    public: path.join(root, 'public'), styles: path.join(root, 'styles'), styleReferences: path.join(root, 'style-references'),
    userStyleReferences: path.join(root, 'data', 'user-style-references'),
    generated: path.join(root, 'data', 'generated'), audio: path.join(root, 'data', 'audio'), videos: path.join(root, 'data', 'videos'),
    subtitles: path.join(root, 'data', 'subtitles'),
    stubs: path.join(root, 'data', 'stubs'), zips: path.join(root, 'data', 'zips'), projects: path.join(root, 'data', 'projects'),
    jobs: path.join(root, 'data', 'jobs'), idempotency: path.join(root, 'data', 'idempotency'),
    generationCache: path.join(root, 'data', 'generation-cache'),
    videoAttempts: path.join(root, 'data', 'video-attempts'),
    piper: env.PIPER_BINARY_PATH || path.join(root, 'vendor', 'piper', 'piper'),
    piperVoices: path.join(root, 'vendor', 'piper', 'voices'),
    ltxShared: path.resolve(env.LTX_SHARED_DIR || '/home/administrator/web/ltx-env/io/basic-cartoon-poc'),
  };
  const storageBackend = String(env.STORAGE_BACKEND || 'local').toLowerCase();
  return {
    port: integer(env.PORT, 3000, 1, 65535), paths,
    storage: {
      backend: storageBackend,
      r2: {
        accountId: String(env.R2_ACCOUNT_ID || ''),
        accessKeyId: String(env.R2_ACCESS_KEY_ID || ''),
        secretAccessKey: String(env.R2_SECRET_ACCESS_KEY || ''),
        bucket: String(env.R2_BUCKET || ''),
        endpoint: String(env.R2_ENDPOINT || ''),
      },
    },
    limits: { references: 8, referenceBytes: 8 * 1024 * 1024, script: 200_000, prompt: 20_000, line: 2_000, json: '10mb' },
    generationConcurrency: integer(env.GENERATION_CONCURRENCY, 1, 1, 32),
    mediaOutputDefaults: {
      aspectRatio: env.MEDIA_DEFAULT_ASPECT_RATIO || PLATFORM_MEDIA_DEFAULTS.aspectRatio,
      image: {
        aspectRatio: env.MEDIA_IMAGE_DEFAULT_ASPECT_RATIO || PLATFORM_MEDIA_DEFAULTS.image.aspectRatio,
        resolutionTier: env.MEDIA_IMAGE_DEFAULT_RESOLUTION_TIER || PLATFORM_MEDIA_DEFAULTS.image.resolutionTier,
        quality: env.MEDIA_IMAGE_DEFAULT_QUALITY || env.OPENAI_IMAGE_QUALITY || PLATFORM_MEDIA_DEFAULTS.image.quality,
      },
      video: {
        aspectRatio: env.MEDIA_VIDEO_DEFAULT_ASPECT_RATIO || PLATFORM_MEDIA_DEFAULTS.video.aspectRatio,
        resolutionTier: env.MEDIA_VIDEO_DEFAULT_RESOLUTION_TIER || PLATFORM_MEDIA_DEFAULTS.video.resolutionTier,
      },
    },
    billing: { customerChargingEnabled: enabled(env.BILLING_CUSTOMER_CHARGING_ENABLED) },
    payments: {
      publicAppUrl: String(env.PUBLIC_APP_URL || `http://localhost:${integer(env.PORT, 3000, 1, 65535)}`).replace(/\/+$/, ''),
      stripeSecretKey: String(env.STRIPE_SECRET_KEY || ''),
      stripeWebhookSecret: String(env.STRIPE_WEBHOOK_SECRET || ''),
    },
    sparkUrl: String(env.SPARK_TTS_URL || 'http://localhost:8001').replace(/\/+$/, ''), sparkTimeout: integer(env.SPARK_TTS_TIMEOUT_MS, 120_000, 1, 600_000), sparkServiceToken: String(env.SPARK_SERVICE_TOKEN || ''),
    piperUrl: String(env.PIPER_SERVICE_URL || '').replace(/\/+$/, ''), piperServiceToken: String(env.PIPER_SERVICE_TOKEN || ''),
    alignUrl: String(env.ALIGNMENT_SERVICE_URL || 'http://localhost:8002').replace(/\/+$/, ''), alignTimeout: integer(env.ALIGNMENT_SERVICE_TIMEOUT_MS, 60_000, 1, 600_000), alignServiceToken: String(env.ALIGNMENT_SERVICE_TOKEN || ''),
    ltxUrl: String(env.LTX_VIDEO_URL || 'http://localhost:8000').replace(/\/+$/, ''), videoProvider: VIDEO_PROVIDERS.includes(env.VIDEO_PROVIDER) ? env.VIDEO_PROVIDER : 'ltx',
    videoReconcileIntervalMs: integer(env.VIDEO_RECONCILE_INTERVAL_MS, 30_000, 1_000, 600_000),
    videoAttemptTimeoutMs: integer(env.VIDEO_ATTEMPT_TIMEOUT_MS, 15 * 60_000, 60_000, 3_600_000),
    piperVoices: String(env.PIPER_VOICE_IDS || PIPER_VOICE_CATALOG.map((v) => v.id).join(',')).split(',').map((x) => x.trim()).filter(Boolean),
    audio: { sampleRate: 24_000, channels: 1, bits: 16, gapMs: 250 }, env,
  };
}

module.exports = { enabled, integer, loadConfig };
