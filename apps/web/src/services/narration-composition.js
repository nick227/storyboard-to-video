const { cleanText } = require('../shared/text');

// Diagnostic only — never put this in a model prompt as a quota to satisfy.
const ENRICH_DIAGNOSTIC_WORDS_PER_CARD = 35;
const TARGET_WORDS_PER_SCENE = 45;

function wordCount(text) {
  return String(text || '').match(/\S+/g)?.length || 0;
}

function comparableText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function softSegmentTarget(chunkText) {
  return Math.max(1, Math.ceil(wordCount(chunkText) / TARGET_WORDS_PER_SCENE));
}

function normalizeBeats(rawBeats = []) {
  if (!Array.isArray(rawBeats)) return [];
  return rawBeats.map((beat, index) => ({
    index,
    intent: cleanText(beat?.intent, 200),
    cutReason: cleanText(beat?.cutReason, 200),
    startAnchor: cleanText(beat?.startAnchor, 120),
    endAnchor: cleanText(beat?.endAnchor, 120),
  })).filter((beat) => beat.startAnchor || beat.intent || beat.cutReason);
}

function findAnchorIndex(haystack, anchor, fromIndex = 0) {
  const rawAnchor = String(anchor || '').trim();
  if (!rawAnchor) return -1;
  const text = String(haystack || '');
  const direct = text.indexOf(rawAnchor, fromIndex);
  if (direct >= 0) return direct;
  // Whitespace-flexible match for near-verbatim anchors.
  const pattern = rawAnchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  try {
    const match = text.slice(fromIndex).match(new RegExp(pattern));
    return match?.index != null ? fromIndex + match.index : -1;
  } catch (_) {
    return -1;
  }
}

/**
 * Place beat starts along narration using startAnchor. When an anchor cannot be found after the
 * previous cursor, that beat merges into the previous beat (recorded in mergedBeats).
 */
function placeBeatsOnNarration(chunkText, beats) {
  const text = String(chunkText || '');
  const normalized = normalizeBeats(beats);
  if (!text.trim()) return { ranges: [], mergedBeats: [] };
  if (!normalized.length) {
    return {
      ranges: [{ start: 0, end: text.length, beatIndexes: [], cutReason: '', intent: '' }],
      mergedBeats: [],
    };
  }

  const ranges = [];
  const mergedBeats = [];
  let cursor = 0;

  normalized.forEach((beat, beatIndex) => {
    let at = findAnchorIndex(text, beat.startAnchor, cursor);
    if (at < 0 && beatIndex === 0) at = 0;
    if (at < 0 || at < cursor) {
      if (!ranges.length) {
        ranges.push({
          start: 0,
          end: text.length,
          beatIndexes: [beatIndex],
          cutReason: beat.cutReason,
          intent: beat.intent,
        });
        cursor = text.length;
        return;
      }
      const prev = ranges[ranges.length - 1];
      prev.beatIndexes.push(beatIndex);
      if (beat.cutReason) {
        prev.cutReason = prev.cutReason
          ? `${prev.cutReason}; merged: ${beat.cutReason}`
          : `merged: ${beat.cutReason}`;
      }
      mergedBeats.push({
        from: beatIndex,
        into: prev.beatIndexes[0],
        reason: 'no clean textual seam for startAnchor',
      });
      return;
    }
    if (ranges.length) ranges[ranges.length - 1].end = at;
    ranges.push({
      start: at,
      end: text.length,
      beatIndexes: [beatIndex],
      cutReason: beat.cutReason,
      intent: beat.intent,
    });
    cursor = at;
  });

  if (ranges.length) {
    ranges[0].start = 0;
    ranges[ranges.length - 1].end = text.length;
  }

  return {
    ranges: ranges.filter((range) => range.end > range.start && text.slice(range.start, range.end).trim()),
    mergedBeats,
  };
}

function densityUnderSegmented(chunkText, segmentCount, enrich) {
  if (!enrich) return false;
  const words = wordCount(chunkText);
  if (!words || segmentCount < 1) return false;
  const floor = Math.max(1, Math.ceil(words / ENRICH_DIAGNOSTIC_WORDS_PER_CARD));
  return segmentCount < floor;
}

function compositionModeBlock(enrich) {
  if (enrich) {
    return `MODE: enriched narration. Multiple showable stills per paragraph are normal. Prefer short reaction, bridge, atmosphere, and hold cards when real narration text supports them. Cut for imagery, not speaker turns.`;
  }
  return `MODE: literal narration. Stay calmer — fewer optional pause cards. Still cut when the picture must change; do not invent atmospheric beats the text does not support.`;
}

function styleCompositionBlock(orchestratorGuidance = '') {
  const styleCuts = cleanText(orchestratorGuidance, 2_000);
  if (styleCuts) {
    return `STYLE COMPOSITION (primary — how THIS show is directed):
${styleCuts}

If STYLE COMPOSITION is silent, fall back to: one showable unit per card; split early when focus, claim, action, reveal, or reaction changes.`;
  }
  return `DEFAULT COMPOSITION:
- One showable unit per card (new focus, action, reveal, reaction, claim, bridge, or transition).
- Prefer short cards that each earn a distinct still; combine only calm lines that truly share one image.
- Never pack several distinct visual moves into one card.
- Pause/reaction/bridge cards are valid only when real narration text backs them.`;
}

function buildCoverageRequest({
  chunkText,
  sourceText,
  enrich = true,
  orchestratorGuidance = '',
  maxShots,
  chunkBudget,
  undersegmentRetry = false,
}) {
  const ceiling = maxShots
    ? `Soft ceiling reminder (not a target): whole project ≤ ${maxShots} cards; this excerpt's share ≈ ${chunkBudget}. Prefer composition over filling a quota.`
    : 'Do not chase a segment count. Let coverage decide.';

  return `You are the creative director outlining visual coverage before any exact cuts.

Return strict JSON only:
{"beats":[{"intent":"...","cutReason":"...","startAnchor":"...","endAnchor":"..."}]}

Each beat is one showable still. Dialogue and context inform emotion and timing; they do NOT dictate cut points — cut for imagery.

ANCHORS (required):
- startAnchor / endAnchor = short phrases copied from the narration excerpt (ordered semantic anchors).
- They must be locatable in the narration so a later slicer can place seams deterministically.
- Prefer distinctive phrases near where the card should begin/end.

CREATIVE LAW:
- One beat = one still. If a stretch needs two images, emit two beats.
- Pause/reaction/bridge/hold beats are welcome when real narration supports them — never invent silent beats with no text.
- ${compositionModeBlock(enrich)}
- ${ceiling}
${undersegmentRetry ? '\nPREVIOUS OUTLINE UNDER-SEGMENTED: the last pass packed too much into too few stills. Re-outline with more distinct visual beats where the narration supports them.\n' : ''}
${styleCompositionBlock(orchestratorGuidance)}

Finalized narration excerpt:
${chunkText}

Source script excerpt (context only — do not copy as beats):
${sourceText}`;
}

function buildAnchoredSegmentationRequest({
  chunkText,
  sourceText,
  beats = [],
  maxShots,
  chunkBudget,
  orchestratorGuidance = '',
}) {
  const beatBlock = normalizeBeats(beats).map((beat, index) => (
    `${index + 1}. intent=${beat.intent || '(none)'} | cutReason=${beat.cutReason || '(none)'} | startAnchor="${beat.startAnchor}" | endAnchor="${beat.endAnchor}"`
  )).join('\n') || '(no beats — fall back to one showable unit per distinct visual move)';

  const ceiling = maxShots
    ? `Soft ceiling: whole project ≤ ${maxShots}; this excerpt's share ≈ ${chunkBudget}. Prefer keeping coverage beats; merge only when no clean textual seam exists.`
    : 'Prefer one segment per coverage beat when a clean textual seam exists.';

  return `You are the exact slicer. Coverage beats are creative guidance; you own structural correctness.

Return strict JSON only:
{"segments":[{"sourceScriptFragment":"...","narrationText":"...","cutReason":"...","beatIndex":0}]}

HARD RULES:
- narrationText = exact copied excerpt of the narration below (never rewrite).
- Preserve order. Concatenated narrationText must equal the full narration excerpt.
- sourceScriptFragment = exact ordered source excerpt for that segment. Concatenated sources must equal the full source excerpt.
- Prefer one segment per coverage beat using startAnchor/endAnchor to place seams.
- If two adjacent beats share no clean textual seam, MERGE them into one segment and set cutReason to note the merge — never invent empty/silent segments.
- cutReason = short director note (≤20 words), composition-flavored.
- ${ceiling}

COVERAGE BEATS (guidance):
${beatBlock}

${styleCompositionBlock(orchestratorGuidance)}

Finalized narration excerpt:
${chunkText}

Source script excerpt:
${sourceText}`;
}

/**
 * Prefer model segments when they preserve narration exactly; otherwise deterministically slice by
 * coverage anchors. Never fabricate empty cards.
 */
function reconcileSegments({
  chunkText,
  sourceText,
  beats,
  modelSegments,
  partitionSourceRange,
  sourceStart = 0,
}) {
  const narration = String(chunkText || '');
  const cleanedModel = (Array.isArray(modelSegments) ? modelSegments : [])
    .map((item) => ({
      narrationText: cleanText(item?.narrationText, 20_000),
      cutReason: cleanText(item?.cutReason, 200),
      sourceScriptFragment: cleanText(item?.sourceScriptFragment, 20_000),
      beatIndex: Number.isInteger(item?.beatIndex) ? item.beatIndex : null,
    }))
    .filter((item) => item.narrationText);

  const modelConcatOk = cleanedModel.length
    && comparableText(cleanedModel.map((item) => item.narrationText).join(' ')) === comparableText(narration);

  if (modelConcatOk) {
    const providedSources = cleanedModel.map((item) => item.sourceScriptFragment);
    let localCursor = 0;
    let exactSourceRanges = [];
    const sourceChunk = String(sourceText || '');
    for (const fragment of providedSources) {
      const located = fragment ? sourceChunk.indexOf(fragment, localCursor) : -1;
      if (located < 0 || sourceChunk.slice(localCursor, located).trim()) {
        exactSourceRanges = [];
        break;
      }
      exactSourceRanges.push({
        sourceScriptFragment: fragment,
        sourceStart: sourceStart + located,
        sourceEnd: sourceStart + located + fragment.length,
        sourceMappingMethod: 'model',
      });
      localCursor = located + fragment.length;
    }
    if (sourceChunk.slice(localCursor).trim()) exactSourceRanges = [];
    const sourceRanges = exactSourceRanges.length === cleanedModel.length
      ? exactSourceRanges
      : partitionSourceRange(sourceChunk, cleanedModel.map((item) => item.narrationText), sourceStart);

    const mergedBeats = [];
    const beatCount = normalizeBeats(beats).length;
    if (beatCount > cleanedModel.length) {
      mergedBeats.push({
        from: cleanedModel.length,
        to: beatCount - 1,
        reason: 'model returned fewer legal slices than coverage beats',
      });
    }

    return {
      segments: cleanedModel.map((item, index) => ({
        narrationText: item.narrationText,
        cutReason: item.cutReason,
        ...sourceRanges[index],
      })),
      mergedBeats,
      usedDeterministicSlice: false,
    };
  }

  const { ranges, mergedBeats } = placeBeatsOnNarration(narration, beats);
  const parts = ranges.map((range) => narration.slice(range.start, range.end));
  const sourceRanges = partitionSourceRange(String(sourceText || ''), parts, sourceStart);
  return {
    segments: ranges.map((range, index) => ({
      narrationText: parts[index],
      cutReason: range.cutReason || '',
      ...sourceRanges[index],
    })).filter((segment) => segment.narrationText),
    mergedBeats,
    usedDeterministicSlice: true,
  };
}

module.exports = {
  TARGET_WORDS_PER_SCENE,
  ENRICH_DIAGNOSTIC_WORDS_PER_CARD,
  wordCount,
  comparableText,
  softSegmentTarget,
  normalizeBeats,
  findAnchorIndex,
  placeBeatsOnNarration,
  densityUnderSegmented,
  buildCoverageRequest,
  buildAnchoredSegmentationRequest,
  reconcileSegments,
  styleCompositionBlock,
};
