#!/usr/bin/env node
// Smoke: Start Planning must fill missing prompts in place and never rebuild scenes/media.
// Run: node --require ./test/setup.js scripts/smoke-test-planning-preserve.js
const assert = require('node:assert/strict');
const path = require('node:path');

function installLocalStorageShim() {
  const data = new Map();
  global.localStorage = {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
  };
}

function pass(label) {
  console.log(`  PASS  ${label}`);
}

async function main() {
  console.log('Smoke: planning preserve / skip generated entities\n');
  installLocalStorageShim();
  const originalFetch = global.fetch;
  let prepareCalls = 0;
  let planVisualCalls = 0;
  const regeneratedIndexes = [];

  global.fetch = async (url, options) => {
    const json = (body, status = 200) => ({
      ok: status < 400,
      status,
      text: async () => JSON.stringify(body),
    });
    if (String(url).startsWith('/api/storyboard/prepare-narration')) {
      prepareCalls += 1;
      return json({
        scenes: [
          { sceneNumber: 1, title: 'Scene 1', narrationText: 'Merged.', prompt: '', beat: '' },
          { sceneNumber: 2, title: 'Scene 2', narrationText: 'Merged.', prompt: '', beat: '' },
          { sceneNumber: 3, title: 'Scene 3', narrationText: 'Merged.', prompt: '', beat: '' },
        ],
      });
    }
    if (String(url).startsWith('/api/storyboard/plan-visuals')) {
      planVisualCalls += 1;
      return json({ scenes: [] });
    }
    if (String(url).startsWith('/api/storyboard/regenerate-prompt')) {
      const body = JSON.parse(options?.body || '{}');
      regeneratedIndexes.push(body.sceneIndex);
      return json({ prompt: `Filled ${body.sceneIndex + 1}.`, usedFallback: false });
    }
    return json({ project: { revision: 2, scenes: [] }, jobs: [] });
  };

  try {
    const stagesPath = path.join(__dirname, '..', 'public', 'js', 'generation', 'stages.js');
    const storePath = path.join(__dirname, '..', 'public', 'js', 'core', 'store.js');
    const { classifyPlanningRun, runCreateStoryFlow } = await import(stagesPath);
    const { projectStore, sceneStore, uiStore } = await import(storePath);

    assert.equal(classifyPlanningRun({ total: 0, missing: 0, stale: 0 }), 'full');
    assert.equal(classifyPlanningRun({ total: 4, missing: 3, stale: 0 }), 'patch');
    assert.equal(classifyPlanningRun({ total: 4, missing: 0, stale: 0 }, { force: true }), 'refresh');
    assert.equal(classifyPlanningRun({ total: 4, missing: 0, stale: 0, hasChanges: true }), 'current');
    pass('classifyPlanningRun: full only when empty; missing → patch; force → refresh');

    const scenes = [
      {
        id: 's1',
        title: 'Scene 1',
        narrationText: 'One.',
        beat: 'Act 1.',
        prompt: 'Prompt 1.',
        promptGeneratedFromBeat: 'Act 1.',
        promptGeneratedFromNarration: 'One.',
        versions: [{ path: 'images/scene1.png', scenePrompt: 'Prompt 1.' }],
        activeVersionIndex: 0,
      },
      { id: 's2', title: 'Scene 2', narrationText: 'Two.', beat: '', prompt: '' },
      { id: 's3', title: 'Scene 3', narrationText: 'Three.', beat: '', prompt: '' },
      { id: 's4', title: 'Scene 4', narrationText: 'Four.', beat: '', prompt: '' },
    ];
    const record = {
      id: 'smoke-planning-preserve',
      title: 'Smoke Planning Preserve',
      revision: 1,
      scenes,
      scriptText: 'Source.',
      styleId: 'basic-cartoon',
      textProvider: 'openai',
      commonPromptText: '',
      enrich: false,
      lastPromptInputs: {
        scriptText: 'Source.',
        styleId: 'basic-cartoon',
        textProvider: 'openai',
        commonPromptText: '',
        enrich: false,
        maxShots: null,
      },
      lastNarrationInputs: {
        scriptText: 'Source.',
        textProvider: 'openai',
        enrich: false,
        guidance: '',
        narrationPromptText: '',
        maxShots: null,
      },
    };
    projectStore.set({ currentId: record.id, storyboards: [record] });
    sceneStore.set({ scenes });
    uiStore.set({ operation: null });

    const els = {
      scriptText: { value: record.scriptText },
      styleSelect: { value: record.styleId },
      commonPromptText: { value: '' },
      textProvider: { value: 'openai' },
      imageProvider: { value: 'stub' },
      fallbackPolicy: { value: 'local' },
      enrichNarration: { checked: false },
      settingsShotLimitSelect: { value: '' },
    };

    const result = await runCreateStoryFlow('custom', els, () => {}, { stages: ['planning'] });
    assert.equal(result.stoppedAt, null);
    assert.equal(prepareCalls, 0, 'must not call prepare-narration');
    assert.equal(planVisualCalls, 0, 'must not bulk plan-visuals');
    assert.deepEqual(regeneratedIndexes, [1, 2, 3], 'only missing prompts regenerated');
    pass('Start Planning did not restructure; filled scenes 2–4 only');

    const after = sceneStore.get().scenes;
    assert.equal(after.length, 4, 'scene count stays 4');
    assert.equal(after[0].id, 's1');
    assert.equal(after[0].versions[0].path, 'images/scene1.png');
    const scene1Prompt = after[0].prompt || after[0].shots?.[0]?.prompt;
    assert.equal(scene1Prompt, 'Prompt 1.', 'scene 1 prompt untouched');
    pass('scene 1 image + prompt preserved; count still 4');

    console.log('\nAll smoke checks passed.');
  } finally {
    global.fetch = originalFetch;
    delete global.localStorage;
  }
}

main().catch((error) => {
  console.error('\nSMOKE FAILED:', error.message);
  process.exitCode = 1;
});
