const { AsyncLocalStorage } = require('node:async_hooks');
const { ProjectStore } = require('./storage/project-store');
const { JobStore } = require('./storage/job-store');
const { IdempotencyStore } = require('./storage/idempotency-store');
const { GenerationQueue } = require('./services/generation-queue');
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
  const projectStore = new ProjectStore(config.paths.projects);
  const queue = new GenerationQueue({
    concurrency: config.generationConcurrency,
    store: new JobStore(config.paths.jobs),
  });
  const idempotencyStore = new IdempotencyStore(config.paths.idempotency);
  const generationContext = new AsyncLocalStorage();
  const cancellation = () => generationContext.getStore();

  const styles = createStylesService(config);
  const textProviders = createTextProviders(config, cancellation);
  const imageProvider = createImageProviders(config, textProviders, cancellation);
  const audioProvider = createAudioProviders(config, cancellation);
  const videoProvider = createVideoProvider(config, cancellation);
  const prompts = createPromptGenerationService({ textProviders, styles, limits: config.limits });
  const dialogue = createDialogueService({ textProviders });
  const images = createImageGenerationService({ config, styles, provider: imageProvider, projectStore });
  const audio = createAudioGenerationService({ config, provider: audioProvider, projectStore });
  const videos = createVideoGenerationService({ config, provider: videoProvider, projectStore, styles });
  const exports = createExportService({ config, projectStore });
  const voices = createVoiceService(config, cancellation, audioProvider);
  const media = createMediaController({ images, audio, videos, exports });

  const identityStore = overrides.identityStore || new PrismaIdentityRepository(config.env.DATABASE_URL);
  const auth = new AuthService({ identityStore });

  return {
    config, projectStore, queue, idempotencyStore, generationContext,
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
