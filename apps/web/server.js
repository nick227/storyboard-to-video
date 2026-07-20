require('dotenv').config();

const { loadConfig } = require('./src/config/env');
const { createDependencies } = require('./src/dependencies');
const { createApp } = require('./src/app');
const { startServer } = require('./src/server');
const { startVideoReconciliationWorker } = require('./src/workers/video-reconciliation-worker');
const { createAssetResolver } = require('./src/media/assets');
const { buildWavBuffer, concatenatePcmLines } = require('./src/media/wav');
const { clampSceneCount, getAdditionalCommonPrompt } = require('./src/shared/text');
const { providerError } = require('./src/providers/http');

const config = loadConfig();
const dependencies = createDependencies(config);
const app = createApp(dependencies);

if (require.main === module) {
  startServer(app, config);
  startVideoReconciliationWorker(dependencies.videos, { intervalMs: config.videoReconcileIntervalMs });
}

module.exports = {
  app,
  buildScenePrompts: dependencies.prompts.generate,
  buildSceneDialogue: dependencies.dialogue.generate,
  buildWavBuffer,
  clampSceneCount,
  concatenatePcmLines,
  createProviderError: providerError,
  generationQueue: dependencies.queue,
  getAdditionalCommonPrompt,
  projectStore: dependencies.projectStore,
  prisma: dependencies.prisma,
  regenerateSceneDialogue: dependencies.dialogue.regenerate,
  regenerateSinglePrompt: dependencies.prompts.regeneratePrompt,
  resolveAudioAsset: createAssetResolver(config.paths.audio, '/audio'),
  resolveGeneratedAsset: createAssetResolver(config.paths.generated, '/generated'),
  resolveVideoAsset: createAssetResolver(config.paths.videos, '/videos'),
  verifyVideoProvider: dependencies.videos.verify,
};
