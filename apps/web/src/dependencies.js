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
const { GenerationQueue } = require('./services/generation-queue');
const { createProviderUsageService } = require('./services/provider-usage.service');
const { createBillingService } = require('./services/billing.service');
const { createPaymentService } = require('./services/payment.service');
const Stripe = require('stripe');
const { createStylesService } = require('./services/styles.service');
const { createTextProviders } = require('./providers/text');
const { createImageProviders } = require('./providers/image');
const { createAudioProviders } = require('./providers/audio');
const { createVideoProvider } = require('./providers/video');
const { createPromptGenerationService } = require('./services/prompt-generation.service');
const { createDialogueService } = require('./services/dialogue.service');
const { createImageGenerationService } = require('./services/image-generation.service');
const { createAudioGenerationService } = require('./services/audio-generation.service');
const { createVideoGenerationService } = require('./services/video-generation.service');
const { createExportService } = require('./services/export.service');
const { createVoiceService } = require('./services/voice.service');
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

  const styles = createStylesService(config);
  const textProviders = createTextProviders(config, cancellation, usageTracker);
  const imageProvider = createImageProviders(config, textProviders, cancellation, usageTracker);
  const audioProvider = createAudioProviders(config, cancellation, usageTracker);
  const videoProvider = createVideoProvider(config, cancellation, usageTracker);
  const prompts = createPromptGenerationService({ textProviders, styles, limits: config.limits });
  const dialogue = createDialogueService({ textProviders });
  const images = createImageGenerationService({ config, styles, provider: imageProvider, projectStore });
  const audio = createAudioGenerationService({ config, provider: audioProvider, projectStore });
  const videos = createVideoGenerationService({ config, provider: videoProvider, projectStore, styles });
  const exports = createExportService({ config, projectStore });
  const voices = createVoiceService(config, cancellation, audioProvider);
  const media = createMediaController({ images, audio, videos, exports });

  const identityStore = overrides.identityStore || new PrismaIdentityRepository(prisma);
  const auth = new AuthService({ identityStore });

  return {
    config, prisma, projectStore, queue, idempotencyStore, usageRepository, usageTracker, billingRepository, billing, adminRepository, paymentRepository, payments, generationContext,
    styles, prompts, dialogue, images, audio, videos, exports, voices,
    upload: createUpload(config),
    auth,
    authenticate: auth.middleware(),
    idempotency: requireIdempotency(idempotencyStore, projectStore),
    execute: createJobExecution({ queue, projectStore, idempotencyStore, generationContext }),
    controllers: {
      storyboard: createStoryboardController({ styles, prompts, dialogue, config }),
      media,
      styles: createStylesController(styles),
      voices: createVoiceController(voices),
      assets: createAssetsController({ config, projectStore, styles }),
    },
  };
}

module.exports = { createDependencies };
