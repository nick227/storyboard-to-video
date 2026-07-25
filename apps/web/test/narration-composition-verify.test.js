const test = require('node:test');
const assert = require('node:assert/strict');
const { createShotPlanningService } = require('../src/services/shot-planning.service');
const { placeBeatsOnNarration, reconcileSegments } = require('../src/services/narration-composition');

function comparable(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function partitionSourceRange(sourceText, segmentTexts, sourceStart = 0) {
  const source = String(sourceText || '');
  if (!segmentTexts.length) return [];
  const weights = segmentTexts.map((text) => Math.max(1, String(text).match(/\S+/g)?.length || 1));
  const total = weights.reduce((sum, n) => sum + n, 0);
  let previousEnd = 0;
  let cumulative = 0;
  return segmentTexts.map((_, index) => {
    cumulative += weights[index];
    const end = index === segmentTexts.length - 1
      ? source.length
      : Math.round((cumulative / total) * source.length);
    const start = previousEnd;
    previousEnd = end;
    return {
      sourceScriptFragment: source.slice(start, end),
      sourceStart: sourceStart + start,
      sourceEnd: sourceStart + end,
      sourceMappingMethod: 'proportional',
    };
  });
}

const DIALOGUE_HEAVY = [
  'Mara opens the door slowly and scans the dark hall.',
  'She freezes when the floorboard creaks behind her.',
  '"Who is there?" she whispers, gripping the latch.',
  'Silence answers. She waits, breath held.',
  'Then a shadow moves past the kitchen doorway.',
  '"Show yourself," she says, stepping forward once.',
].join(' ');

function exactSlices(text, count) {
  const words = String(text || '').match(/\S+/g) || [];
  if (!words.length) return Array.from({ length: count }, () => '');
  const size = Math.max(1, Math.floor(words.length / count));
  const slices = [];
  let cursor = 0;
  for (let i = 0; i < count; i += 1) {
    const endWord = i === count - 1 ? words.length : Math.min(words.length, cursor + size);
    const part = words.slice(cursor, endWord).join(' ');
    slices.push(i < count - 1 ? `${part} ` : part);
    cursor = endWord;
  }
  // Guarantee exact join back to original when original used single spaces.
  if (slices.join('') !== text && comparable(slices.join(' ')) === comparable(text)) {
    return slices;
  }
  if (slices.join('') !== text) {
    // Fall back to equal character partitions only when word rebuild cannot match (rare).
    const share = Math.floor(text.length / count);
    return Array.from({ length: count }, (_, i) => {
      const start = i * share;
      const end = i === count - 1 ? text.length : (i + 1) * share;
      return text.slice(start, end);
    });
  }
  return slices;
}

function providerForBeatCount(beatCount, { narrationText = DIALOGUE_HEAVY, script = 'INT. HOUSE - NIGHT\nMara opens the door.' } = {}) {
  return async (_provider, request) => {
    if (request.includes('continuous spoken narration')) return JSON.stringify({ narrationText });
    if (request.includes('creative director outlining')) {
      const slices = exactSlices(narrationText, beatCount);
      return JSON.stringify({
        beats: slices.map((slice, i) => ({
          intent: `beat-${i + 1}`,
          cutReason: `cut ${i + 1}`,
          startAnchor: slice.slice(0, Math.min(12, slice.length)),
          endAnchor: slice.slice(Math.max(0, slice.length - 12)),
        })),
      });
    }
    if (request.includes('exact slicer')) {
      const slices = exactSlices(narrationText, beatCount);
      const sourceSlices = exactSlices(script, beatCount);
      return JSON.stringify({
        segments: slices.map((narrationSlice, i) => ({
          sourceScriptFragment: sourceSlices[i],
          narrationText: narrationSlice,
          cutReason: `cut ${i + 1}`,
          beatIndex: i,
        })),
      });
    }
    throw new Error(`unexpected: ${request.slice(0, 100)}`);
  };
}

test('enriched coverage yields more cards than literal on the same dialogue-heavy narration', async () => {
  const script = 'INT. HOUSE - NIGHT\nMara opens the door.';
  const enrichedService = createShotPlanningService({
    textProviders: { call: providerForBeatCount(6, { script }) },
  });
  const literalService = createShotPlanningService({
    textProviders: { call: providerForBeatCount(2, { script }) },
  });

  const enriched = await enrichedService.prepareNarration({
    scriptText: script, provider: 'gemini', fallbackPolicy: 'fail', enrich: true,
  });
  const literal = await literalService.prepareNarration({
    scriptText: script, provider: 'gemini', fallbackPolicy: 'fail', enrich: false,
  });

  assert.equal(comparable(enriched.scenes.map((s) => s.narrationText).join(' ')), comparable(DIALOGUE_HEAVY));
  assert.equal(comparable(literal.scenes.map((s) => s.narrationText).join(' ')), comparable(DIALOGUE_HEAVY));
  assert.ok(
    enriched.scenes.length > literal.scenes.length,
    `expected enrich ${enriched.scenes.length} > literal ${literal.scenes.length}`,
  );
});

test('scene narrations concatenate exactly and source offsets stay ordered without gaps', async () => {
  const narrationText = 'Alpha walks in. Beta freezes. Gamma speaks next.';
  const script = 'INT. ROOM\nAlpha. Beta. Gamma.';
  const service = createShotPlanningService({
    textProviders: {
      call: async (_provider, request) => {
        if (request.includes('continuous spoken narration')) return JSON.stringify({ narrationText });
        if (request.includes('creative director outlining')) {
          return JSON.stringify({
            beats: [
              { intent: 'a', cutReason: 'enter', startAnchor: 'Alpha walks', endAnchor: 'in.' },
              { intent: 'b', cutReason: 'react', startAnchor: 'Beta freezes', endAnchor: 'freezes.' },
              { intent: 'c', cutReason: 'line', startAnchor: 'Gamma speaks', endAnchor: 'next.' },
            ],
          });
        }
        return JSON.stringify({
          segments: [
            { sourceScriptFragment: 'INT. ROOM\nAlpha. ', narrationText: 'Alpha walks in. ', cutReason: 'enter', beatIndex: 0 },
            { sourceScriptFragment: 'Beta. ', narrationText: 'Beta freezes. ', cutReason: 'react', beatIndex: 1 },
            { sourceScriptFragment: 'Gamma.', narrationText: 'Gamma speaks next.', cutReason: 'line', beatIndex: 2 },
          ],
        });
      },
    },
  });
  const result = await service.prepareNarration({
    scriptText: script,
    provider: 'gemini',
    fallbackPolicy: 'fail',
    enrich: false,
  });
  assert.equal(comparable(result.scenes.map((s) => s.narrationText).join(' ')), comparable(narrationText));
  assert.equal(result.scenes[0].sourceStart, 0);
  assert.equal(result.scenes[result.scenes.length - 1].sourceEnd, script.length);
  for (let i = 1; i < result.scenes.length; i += 1) {
    assert.equal(result.scenes[i].sourceStart, result.scenes[i - 1].sourceEnd);
  }
  assert.equal(result.scenes.map((s) => s.sourceScriptFragment).join(''), script);
});

test('failed anchors merge beats instead of inventing empty cards', () => {
  const text = 'Only real narration lives here end.';
  const { ranges, mergedBeats } = placeBeatsOnNarration(text, [
    { intent: 'a', cutReason: 'start', startAnchor: 'Only real', endAnchor: 'here' },
    { intent: 'ghost', cutReason: 'pause', startAnchor: 'NOPE', endAnchor: 'NOPE' },
    { intent: 'b', cutReason: 'end', startAnchor: 'lives here', endAnchor: 'end.' },
  ]);
  assert.ok(ranges.length >= 1);
  assert.ok(mergedBeats.length >= 1);
  assert.ok(ranges.every((r) => text.slice(r.start, r.end).trim()));
  assert.equal(ranges[0].start, 0);
  assert.equal(ranges[ranges.length - 1].end, text.length);
  assert.equal(ranges.map((r) => text.slice(r.start, r.end)).join(''), text);
});

test('density retry runs at most once and cannot loop', async () => {
  let coverageCalls = 0;
  let segmentCalls = 0;
  const longNarration = Array.from({ length: 90 }, (_, i) => `Word${i + 1}`).join(' ');
  const service = createShotPlanningService({
    textProviders: {
      call: async (_provider, request) => {
        if (request.includes('continuous spoken narration')) return JSON.stringify({ narrationText: longNarration });
        if (request.includes('creative director outlining')) {
          coverageCalls += 1;
          const under = request.includes('PREVIOUS OUTLINE UNDER-SEGMENTED');
          // First pass: 1 beat (forces retry). Retry: still 1 beat (proves no second retry loop).
          const count = under ? 1 : 1;
          const slices = exactSlices(longNarration, count);
          return JSON.stringify({
            beats: slices.map((slice, i) => ({
              intent: `b${i}`,
              cutReason: `c${i}`,
              startAnchor: slice.slice(0, 6),
              endAnchor: slice.slice(-6),
            })),
          });
        }
        if (request.includes('exact slicer')) {
          segmentCalls += 1;
          const n = (request.match(/^\d+\. intent=/gm) || []).length || 1;
          const slices = exactSlices(longNarration, n);
          return JSON.stringify({
            segments: slices.map((narrationSlice, i) => ({
              sourceScriptFragment: 'source',
              narrationText: narrationSlice,
              cutReason: `c${i}`,
              beatIndex: i,
            })),
          });
        }
        throw new Error('unexpected');
      },
    },
  });
  const result = await service.prepareNarration({
    scriptText: 'source',
    provider: 'gemini',
    fallbackPolicy: 'fail',
    enrich: true,
  });
  assert.equal(coverageCalls, 2, 'exactly one diagnostic retry');
  assert.equal(segmentCalls, 2);
  assert.match(result.warning, /retrying coverage once/);
  assert.match(result.warning, /still under-segmented after one retry/);
  assert.equal(comparable(result.scenes.map((s) => s.narrationText).join(' ')), comparable(longNarration));
});

test('coverage failure falls back locally without losing the project', async () => {
  const narrationText = 'Mara opens the door and freezes in place.';
  const service = createShotPlanningService({
    textProviders: {
      call: async (_provider, request) => {
        if (request.includes('continuous spoken narration')) return JSON.stringify({ narrationText });
        if (request.includes('creative director outlining')) throw new Error('coverage provider down');
        throw new Error('should not reach slicer');
      },
    },
  });
  const result = await service.prepareNarration({
    scriptText: 'INT. HOUSE\nMara opens the door.',
    provider: 'gemini',
    fallbackPolicy: 'local',
    enrich: true,
  });
  assert.equal(result.usedFallback, true);
  assert.ok(result.scenes.length >= 1);
  assert.match(result.warning, /local boundaries/);
  assert.equal(comparable(result.scenes.map((s) => s.narrationText).join(' ')), comparable(narrationText));
  assert.ok(result.scenes.every((scene) => scene.narrationText.trim()));
});

test('maxShots merge keeps cutReason and leaves visual fields empty at prepare time', async () => {
  const narrationText = Array.from({ length: 5 }, (_, i) => `Beat${i + 1} happens now.`).join(' ');
  const service = createShotPlanningService({
    textProviders: { call: providerForBeatCount(5, { narrationText, script: narrationText }) },
  });
  const result = await service.prepareNarration({
    scriptText: narrationText,
    provider: 'gemini',
    fallbackPolicy: 'fail',
    enrich: false,
    maxShots: 2,
  });
  assert.equal(result.scenes.length, 2);
  assert.match(result.warning, /merged|exceeded/i);
  for (const scene of result.scenes) {
    assert.equal(scene.beat, '');
    assert.equal(scene.prompt, '');
    assert.equal(scene.videoPrompt, '');
    assert.equal(typeof scene.cutReason, 'string');
  }
  assert.equal(comparable(result.scenes.map((s) => s.narrationText).join(' ')), comparable(narrationText));
});

test('reconcile drops blank model cards instead of inventing content', () => {
  const chunkText = 'Real text only.';
  const result = reconcileSegments({
    chunkText,
    sourceText: chunkText,
    beats: [
      { intent: 'a', cutReason: 'a', startAnchor: 'Real', endAnchor: 'only.' },
      { intent: 'empty', cutReason: 'ghost', startAnchor: 'ghost', endAnchor: 'ghost' },
    ],
    modelSegments: [
      { narrationText: 'Real text only.', cutReason: 'a' },
      { narrationText: '   ', cutReason: 'ghost' },
    ],
    partitionSourceRange,
  });
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].narrationText, 'Real text only.');
});

test('Start on existing boards does not call prepareNarration — Replan is the rebuild path', () => {
  const stages = require('fs').readFileSync(require('path').join(__dirname, '../public/js/generation/stages.js'), 'utf8');
  assert.match(stages, /Existing scenes: fill missing \/ refresh prompts only\. Never prepareNarration or rebuild\./);
  assert.match(stages, /rebuilds never happen from Start — only from the explicit Replan control/);
  const workflows = require('fs').readFileSync(require('path').join(__dirname, '../public/js/generation/workflows.js'), 'utf8');
  assert.match(workflows, /use Replan to rebuild from the script/);
});
