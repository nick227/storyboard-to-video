const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ProjectStore } = require('../src/storage/project-store');
const { createMediaOutputService } = require('../src/services/media-output.service');
const { PLATFORM_MEDIA_DEFAULTS } = require('../src/shared/media-output-policy');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-output-service-'));
  const config = { env: {}, videoProvider: 'ltx', mediaOutputDefaults: PLATFORM_MEDIA_DEFAULTS };
  const store = new ProjectStore(path.join(root, 'projects'));
  const videoProviders = {
    resolve({ provider, model }) {
      if (!['ltx', 'stub', 'minimax'].includes(provider)) throw new Error(`unexpected provider ${provider}`);
      return { model: model || (provider === 'minimax' ? 'MiniMax-Hailuo-02' : `${provider}-default-model`) };
    },
  };
  return { root, config, store, videoProviders, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('media output selection falls back to the project default video provider, and an explicit request still overrides it', async () => {
  const f = fixture();
  try {
    f.store.create({ id: 'quote-project', project: { scenes: [] } });
    let project = f.store.read('quote-project');
    f.store.write('quote-project', { ...project, mediaSettings: { video: { provider: 'stub', model: 'stub-video-v1' } } }, { expectedRevision: project.revision });

    const service = createMediaOutputService({ config: f.config, projectStore: f.store, billing: null, videoProviders: f.videoProviders });

    const defaulted = await service.selection({ modality: 'video', projectId: 'quote-project' });
    assert.equal(defaulted.provider, 'stub', 'no explicit provider must fall back to the project default');
    assert.equal(defaulted.model, 'stub-video-v1', 'project default model must apply alongside the project default provider');

    const overridden = await service.selection({ modality: 'video', projectId: 'quote-project', provider: 'ltx' });
    assert.equal(overridden.provider, 'ltx', 'an explicit request provider must still win over the project default');
    assert.equal(overridden.model, 'ltx-default-model', 'a project model for a different provider must not leak onto an overridden provider');
  } finally {
    f.cleanup();
  }
});

test('video duration options come from the server resolver for the selected provider tuple', async () => {
  const f = fixture();
  try {
    const service = createMediaOutputService({ config: f.config, projectStore: f.store, billing: null, videoProviders: f.videoProviders });
    const ltx = await service.videoDurationOptions({ provider: 'ltx', outputIntent: { aspectRatio: '16:9', video: { resolutionTier: 'draft' } } });
    assert.equal(ltx.providerDefault.supported, true);
    assert.deepEqual(ltx.options.filter((item) => item.supported).map((item) => item.durationSeconds), [2, 4, 6, 8, 10, 12]);

    const minimax = await service.videoDurationOptions({ provider: 'minimax', outputIntent: { aspectRatio: '16:9', video: { resolutionTier: 'standard' } } });
    assert.equal(minimax.providerDefault.output.resolved.durationSeconds, 6);
    assert.deepEqual(minimax.options.filter((item) => item.supported).map((item) => item.durationSeconds), [6, 10]);
  } finally {
    f.cleanup();
  }
});

test('image resolution and quality options come from the server provider/model resolver', async () => {
  const f = fixture();
  try {
    const service = createMediaOutputService({ config: f.config, projectStore: f.store, billing: null, videoProviders: f.videoProviders });
    const dezgo = await service.imageOutputOptions({ provider: 'dezgo', outputIntent: { aspectRatio: '16:9', image: { resolutionTier: 'standard', quality: 'medium' } } });
    const supported = dezgo.combinations.filter((item) => item.supported).map((item) => `${item.resolutionTier}/${item.quality}`);
    assert.deepEqual(supported, ['standard/medium']);
    const rejected = dezgo.combinations.find((item) => item.resolutionTier === 'standard' && item.quality === 'low');
    assert.match(rejected.reason, /does not expose image quality low/);
  } finally {
    f.cleanup();
  }
});
