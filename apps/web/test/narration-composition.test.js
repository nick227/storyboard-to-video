const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findAnchorIndex,
  placeBeatsOnNarration,
  reconcileSegments,
  densityUnderSegmented,
  buildCoverageRequest,
  buildAnchoredSegmentationRequest,
  softSegmentTarget,
  TARGET_WORDS_PER_SCENE,
} = require('../src/services/narration-composition');

function partitionSourceRange(sourceText, segmentTexts, sourceStart = 0) {
  const source = String(sourceText || '');
  if (!segmentTexts.length) return [];
  const weights = segmentTexts.map((text) => Math.max(1, String(text).split(/\s+/).filter(Boolean).length));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  let previousEnd = 0;
  let cumulativeWeight = 0;
  return segmentTexts.map((_, index) => {
    cumulativeWeight += weights[index];
    const end = index === segmentTexts.length - 1
      ? source.length
      : Math.round((cumulativeWeight / totalWeight) * source.length);
    const startOffset = previousEnd;
    previousEnd = end;
    return {
      sourceScriptFragment: source.slice(startOffset, end),
      sourceStart: sourceStart + startOffset,
      sourceEnd: sourceStart + end,
      sourceMappingMethod: 'proportional',
    };
  });
}

test('findAnchorIndex locates verbatim and whitespace-flexible anchors', () => {
  const text = 'She holds the letter. Then she speaks.';
  assert.equal(findAnchorIndex(text, 'She holds'), 0);
  assert.equal(findAnchorIndex(text, 'Then she speaks'), text.indexOf('Then she speaks'));
  assert.equal(findAnchorIndex(text, 'missing'), -1);
});

test('placeBeatsOnNarration merges beats when startAnchor has no clean seam', () => {
  const text = 'Alpha walks in. Beta freezes hard.';
  const { ranges, mergedBeats } = placeBeatsOnNarration(text, [
    { intent: 'a', cutReason: 'enter', startAnchor: 'Alpha walks', endAnchor: 'in.' },
    { intent: 'b', cutReason: 'react', startAnchor: 'NOT FOUND', endAnchor: 'hard.' },
  ]);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].start, 0);
  assert.equal(ranges[0].end, text.length);
  assert.equal(mergedBeats.length, 1);
  assert.match(ranges[0].cutReason, /merged/);
});

test('reconcileSegments prefers exact model slices and records beat shortfall', () => {
  const chunkText = 'One. Two.';
  const result = reconcileSegments({
    chunkText,
    sourceText: 'SRC One. SRC Two.',
    beats: [
      { intent: '1', cutReason: 'a', startAnchor: 'One', endAnchor: 'One.' },
      { intent: '2', cutReason: 'b', startAnchor: 'Two', endAnchor: 'Two.' },
      { intent: '3', cutReason: 'c', startAnchor: 'ghost', endAnchor: 'ghost' },
    ],
    modelSegments: [
      { narrationText: 'One.', cutReason: 'a', sourceScriptFragment: 'SRC One.' },
      { narrationText: 'Two.', cutReason: 'b', sourceScriptFragment: 'SRC Two.' },
    ],
    partitionSourceRange,
  });
  assert.equal(result.segments.length, 2);
  assert.equal(result.usedDeterministicSlice, false);
  assert.ok(result.mergedBeats.length >= 1);
});

test('reconcileSegments falls back to deterministic anchor slices when model concat fails', () => {
  const chunkText = 'Mara opens the door. She freezes.';
  const result = reconcileSegments({
    chunkText,
    sourceText: chunkText,
    beats: [
      { intent: 'enter', cutReason: 'enter', startAnchor: 'Mara opens', endAnchor: 'door.' },
      { intent: 'react', cutReason: 'react', startAnchor: 'She freezes', endAnchor: 'freezes.' },
    ],
    modelSegments: [{ narrationText: 'WRONG', cutReason: 'x' }],
    partitionSourceRange,
  });
  assert.equal(result.usedDeterministicSlice, true);
  assert.equal(result.segments.length, 2);
  assert.equal(result.segments.map((s) => s.narrationText).join(''), chunkText);
});

test('densityUnderSegmented is enrich-only diagnostic', () => {
  const long = Array.from({ length: 90 }, (_, i) => `w${i}`).join(' ');
  assert.equal(densityUnderSegmented(long, 1, true), true);
  assert.equal(densityUnderSegmented(long, 1, false), false);
  assert.equal(densityUnderSegmented(long, 3, true), false);
});

test('coverage request requires anchors and omits density quotas', () => {
  const request = buildCoverageRequest({
    chunkText: 'Hello world.',
    sourceText: 'INT. ROOM',
    enrich: true,
  });
  assert.match(request, /startAnchor/);
  assert.match(request, /MODE: enriched narration/);
  assert.doesNotMatch(request, /Pacing check/);
  assert.doesNotMatch(request, /~1 segment/);
  assert.equal(TARGET_WORDS_PER_SCENE, 45);
  assert.equal(softSegmentTarget(longText(90)), 2);
});

test('anchored segmentation request embeds coverage beats', () => {
  const request = buildAnchoredSegmentationRequest({
    chunkText: 'Hello world.',
    sourceText: 'INT. ROOM',
    beats: [{ intent: 'open', cutReason: 'new still', startAnchor: 'Hello', endAnchor: 'world.' }],
  });
  assert.match(request, /exact slicer/);
  assert.match(request, /COVERAGE BEATS/);
  assert.match(request, /startAnchor="Hello"/);
});

function longText(n) {
  return Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
}
