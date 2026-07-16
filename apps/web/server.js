require('dotenv').config();

const { loadConfig } = require('./src/config/env');
const { createDependencies } = require('./src/dependencies');
const { createApp } = require('./src/app');
const { startServer } = require('./src/server');
const { createAssetResolver } = require('./src/media/assets');
const { buildWavBuffer, concatenatePcmLines } = require('./src/media/wav');
const { clampSceneCount, getAdditionalCommonPrompt } = require('./src/shared/text');
const { splitIntoScenes } = require('./src/services/prompt-generation.service');
const { providerError } = require('./src/providers/http');

const config = loadConfig();
const dependencies = createDependencies(config);
const app = createApp(dependencies);

if (require.main === module) startServer(app, config);

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
  regenerateSceneDialogue: dependencies.dialogue.regenerate,
  regenerateSinglePrompt: dependencies.prompts.regenerate,
  resolveAudioAsset: createAssetResolver(config.paths.audio, '/audio'),
  resolveGeneratedAsset: createAssetResolver(config.paths.generated, '/generated'),
  resolveVideoAsset: createAssetResolver(config.paths.videos, '/videos'),
  splitIntoScenes,
  verifyVideoProvider: dependencies.videos.verify,
};
