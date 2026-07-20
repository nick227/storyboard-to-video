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
      if (!['ltx', 'stub'].includes(provider)) throw new Error(`unexpected provider ${provider}`);
      return { model: model || `${provider}-default-model` };
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
