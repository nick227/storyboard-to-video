// Target spoken-word count per slide for comfortable pacing (~45 words ≈ 15-20s at a natural spoken
// rate). Runs on the AI's actual narration output, so it reflects real content richness rather than
// guessing from input length -- the upfront, pre-narration guess this module used to also provide
// (suggestSceneCount) was removed once planning stopped needing a target count at all.
const TARGET_WORDS_PER_SLIDE = 45;

// Never suggests fewer slides than currently exist — this only ever proposes growing the storyboard
// to match narration that turned out richer than the original estimate, never shrinking it.
export function suggestSceneCountFromNarration(scenes) {
  const currentCount = Array.isArray(scenes) ? scenes.length : 0;
  if (!currentCount) return currentCount;
  const totalWords = scenes.reduce((sum, scene) => sum + (String(scene?.narrationText || '').match(/\S+/g)?.length || 0), 0);
  if (!totalWords) return currentCount;
  const recommended = Math.ceil(totalWords / TARGET_WORDS_PER_SLIDE);
  return Math.min(50, Math.max(currentCount, recommended));
}

// How many sub-scenes a single split-scene call may request. Must match `splitScene.count.max(...)`
// in apps/web/src/schemas.js (backend and frontend can't share a module across the Node/browser
// boundary, so this value is kept in sync by hand — search for MAX_SPLIT_COUNT if either changes).
export const MAX_SPLIT_COUNT = 8;

// The one clamp every split-scene entry point must use, so the count a user is shown/confirms is
// always one the backend will actually accept.
export function clampSplitCount(count) {
  return Math.min(MAX_SPLIT_COUNT, Math.max(2, Math.round(count) || 2));
}
