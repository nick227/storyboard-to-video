const { AsyncLocalStorage } = require('node:async_hooks');
const { PrismaProjectRepository } = require('./storage/prisma-project.repository');
const { PrismaJobRepository } = require('./storage/prisma-job.repository');
const { PrismaIdempotencyRepository } = require('./storage/prisma-idempotency.repository');
const { createPrismaClient } = require('./storage/prisma-client');
const { PrismaUsageRepository } = require('./storage/prisma-usage.repository');
const { PrismaBillingRepository } = require('./storage/prisma-billing.repository');
const { PrismaAdminRepository } = require('./storage/prisma-admin.repository');
const { PrismaPaymentRepository } = require('./storage/prisma-payment.repository');
const { ProjectStore } = require('./storage/project-store');
const { JobStore } = require('./storage/job-store');
const { IdempotencyStore } = require('./storage/idempotency-store');
const { GenerationCacheStore } = require('./storage/generation-cache-store');
const { PrismaGenerationCacheRepository } = require('./storage/prisma-generation-cache.repository');
const { createGenerationCacheService } = require('./services/generation-cache.service');
const { GenerationQueue } = require('./services/generation-queue');
const { createProviderUsageService } = require('./services/provider-usage.service');
const { createBillingService } = require('./services/billing.service');
const { createPaymentService } = require('./services/payment.service');
const Stripe = require('stripe');
const { createStylesService } = require('./services/styles.service');
const { createTextProviders } = require('./providers/text');
const { createImageProviders } = require('./providers/image');
const { createAudioProviders } = require('./providers/audio');
const { createAlignmentProvider } = require('./providers/alignment');
const { createVideoProviders } = require('./providers/video');
const { createLocalVideoAssetTransport } = require('./providers/video/asset-transport');
const { createVideoExecutionService } = require('./services/video-execution.service');
const { VideoGenerationAttemptStore } = require('./storage/video-generation-attempt-store');
const { PrismaVideoGenerationAttemptRepository } = require('./storage/prisma-video-generation-attempt.repository');
const { createPromptGenerationService } = require('./services/prompt-generation.service');
const { createReferenceGenerationService } = require('./services/reference-generation.service');
const { createDialogueService } = require('./services/dialogue.service');
const { createSceneSplitService } = require('./services/scene-split.service');
const { createShotPlanningService } = require('./services/shot-planning.service');
const { createImageGenerationService } = require('./services/image-generation.service');
const { createAudioGenerationService } = require('./services/audio-generation.service');
const { createVideoGenerationService } = require('./services/video-generation.service');
const { createSubtitleGenerationService } = require('./services/subtitle-generation.service');
const { createShotReferenceService } = require('./services/shot-reference.service');
const { createExportService } = require('./services/export.service');
const { createVoiceService } = require('./services/voice.service');
const { createMediaOutputService } = require('./services/media-output.service');
const { requireIdempotency } = require('./middleware/idempotency');
const { createJobExecution } = require('./jobs/execution');
const { AuthService } = require('./auth');
const { PrismaIdentityRepository } = require('./storage/prisma-identity.repository');
const { createUpload } = require('./middleware/upload');
const { createStoryboardController } = require('./controllers/storyboard.controller');
const { createMediaController } = require('./controllers/media.controller');
const { createStylesController } = require('./controllers/styles.controller');
const { createVoiceController } = require('./controllers/voice.controller');
const { createAssetsController } = require('./controllers/assets.controller');

function createDependencies(config, overrides = {}) {
  const useTestAdapters = Boolean(overrides.identityStore && !overrides.prisma && !overrides.projectStore);
  const prisma = useTestAdapters ? null : (overrides.prisma || createPrismaClient(config.env.DATABASE_URL));
  const projectStore = overrides.projectStore || (useTestAdapters ? new ProjectStore(config.paths.projects) : new PrismaProjectRepository(config.paths.projects, prisma));
  const queue = new GenerationQueue({
    concurrency: config.generationConcurrency,
    store: overrides.jobStore || (useTestAdapters ? new JobStore(config.paths.jobs) : new PrismaJobRepository(prisma)),
  });
  const idempotencyStore = overrides.idempotencyStore || (useTestAdapters ? new IdempotencyStore(config.paths.idempotency) : new PrismaIdempotencyRepository(prisma));
  const generationCacheStore = overrides.generationCacheStore || (useTestAdapters ? new GenerationCacheStore(config.paths.generationCache) : new PrismaGenerationCacheRepository(prisma));
  const generationCache = createGenerationCacheService({ store: generationCacheStore });
  const generationContext = new AsyncLocalStorage();
  const cancellation = () => generationContext.getStore()?.signal || generationContext.getStore();
  const usageRepository = overrides.usageRepository || (prisma ? new PrismaUsageRepository(prisma) : null);
  const billingRepository = overrides.billingRepository || (prisma ? new PrismaBillingRepository(prisma) : null);
  const adminRepository = overrides.adminRepository || (prisma ? new PrismaAdminRepository(prisma) : null);
  const paymentRepository = overrides.paymentRepository || (prisma ? new PrismaPaymentRepository(prisma) : null);
  const billing = overrides.billing || createBillingService({ repository: billingRepository, chargingEnabled: config.billing?.customerChargingEnabled });
  const stripe = overrides.stripe === undefined
    ? (config.payments?.stripeSecretKey ? new Stripe(config.payments.stripeSecretKey, { maxNetworkRetries: 2 }) : null)
    : overrides.stripe;
  const payments = overrides.payments || createPaymentService({
    repository: paymentRepository, stripe, webhookSecret: config.payments?.stripeWebhookSecret, publicAppUrl: config.payments?.publicAppUrl,
  });
  const usageTracker = createProviderUsageService({ repository: usageRepository, generationContext, billing });
  const videoAttemptRepository = overrides.videoAttemptRepository || (prisma ? new PrismaVideoGenerationAttemptRepository(prisma) : new VideoGenerationAttemptStore(config.paths.videoAttempts));

  const styles = createStylesService(config);
  const textProviders = createTextProviders(config, cancellation, usageTracker);
  const imageProvider = createImageProviders(config, textProviders, cancellation, usageTracker);
  const audioProvider = createAudioProviders(config, cancellation, usageTracker);
  const alignmentProvider = createAlignmentProvider(config, cancellation);
  const videoProviders = createVideoProviders(config, cancellation, usageTracker, overrides.videoProviderAdapters);
  const videoExecution = createVideoExecutionService({ providers: videoProviders, attempts: videoAttemptRepository, usageTracker, assetTransport: overrides.videoAssetTransport || createLocalVideoAssetTransport(), attemptTimeoutMs: config.videoAttemptTimeoutMs });
  const prompts = createPromptGenerationService({ textProviders, styles, limits: config.limits, generationCache });
  const referenceGeneration = createReferenceGenerationService({ textProviders });
  const dialogue = createDialogueService({ textProviders, generationCache });
  const sceneSplit = createSceneSplitService({ textProviders, generationCache });
  const shotPlanning = createShotPlanningService({ textProviders, generationCache });
  const images = createImageGenerationService({ config, styles, provider: imageProvider, projectStore });
  const audio = createAudioGenerationService({ config, provider: audioProvider, alignmentProvider, projectStore });
  const videos = createVideoGenerationService({ config, providers: videoProviders, execution: videoExecution, projectStore, styles, attempts: videoAttemptRepository });
  const mediaOutput = createMediaOutputService({ config, projectStore, billing, videoProviders });
  const subtitles = createSubtitleGenerationService({ config, projectStore });
  const shotReferences = createShotReferenceService({ config, projectStore });
  const exports = createExportService({ config, projectStore });
  const voices = createVoiceService(config, cancellation, audioProvider);
  const media = createMediaController({ images, audio, videos, subtitles, exports });

  const identityStore = overrides.identityStore || new PrismaIdentityRepository(prisma);
  const auth = new AuthService({ identityStore });

  return {
    config, prisma, projectStore, queue, idempotencyStore, generationCacheStore, generationCache, usageRepository, usageTracker, videoAttemptRepository, videoProviders, videoExecution, billingRepository, billing, adminRepository, paymentRepository, payments, generationContext, identityStore,
    styles, prompts, referenceGeneration, dialogue, sceneSplit, shotPlanning, images, audio, videos, subtitles, shotReferences, exports, voices, imageProvider, mediaOutput,
    upload: createUpload(config),
    auth,
    authenticate: auth.middleware(),
    idempotency: requireIdempotency(idempotencyStore, projectStore),
    execute: createJobExecution({ queue, projectStore, idempotencyStore, generationContext }),
    controllers: {
      storyboard: createStoryboardController({ styles, prompts, dialogue, sceneSplit, shotPlanning, config }),
      media,
      styles: createStylesController(styles),
      voices: createVoiceController(voices),
      assets: createAssetsController({ config, projectStore, styles }),
    },
  };
}

module.exports = { createDependencies };
