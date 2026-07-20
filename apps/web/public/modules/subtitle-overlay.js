// Shared caption-overlay rendering, used by 3 independently-clocked playback contexts: the audio
// entity modal (real <audio> currentTime), the whole-storyboard Timeline (real media currentTime,
// derived per-segment), and each scene card's individual play button (wall-clock derived). Each
// call site computes its own currentTime the way it already does -- this module only needs a plain
// number, no clock logic of its own.

// How many neighboring words to show on each side of the current one, so the caption reads as a
// moving phrase window rather than either a single flashing word or the entire transcript at once.
export const SUBTITLE_WINDOW_RADIUS = 4;

// Pure: given a word list and a point in time, returns which words should be visible and which one
// (if any) is "live" right now. Returns null if there's nothing to show.
export function pickCaptionWindow(words, currentTime, radius = SUBTITLE_WINDOW_RADIUS) {
  if (!words?.length) return null;
  const currentIndex = words.findIndex((word) => currentTime >= word.start && currentTime < word.end);
  // Between two words (a pause) or past the last word (trailing silence), nothing is "current" --
  // but the window should still track the nearest already-spoken word instead of snapping back to
  // the very start of the transcript.
  let centerIndex = currentIndex;
  if (centerIndex === -1) {
    centerIndex = 0;
    for (let i = 0; i < words.length; i += 1) {
      if (words[i].start > currentTime) break;
      centerIndex = i;
    }
  }
  const start = Math.max(0, centerIndex - radius);
  const end = Math.min(words.length, centerIndex + radius + 1);
  return {
    currentIndex,
    items: words.slice(start, end).map((word, i) => ({ text: word.text, isCurrent: start + i === currentIndex })),
  };
}

// DOM-rendering helper: paints (or clears/hides) the given window into an arbitrary target element.
// Self-contained on `hidden` so every call site can call this unconditionally every tick without
// separately managing visibility.
export function renderCaptionInto(target, words, currentTime, radius = SUBTITLE_WINDOW_RADIUS) {
  if (!target) return;
  const captionWindow = pickCaptionWindow(words, currentTime, radius);
  if (!captionWindow) {
    if (!target.hidden) { target.hidden = true; target.textContent = ''; }
    return;
  }
  target.hidden = false;
  target.textContent = '';
  captionWindow.items.forEach(({ text, isCurrent }) => {
    const span = document.createElement('span');
    span.className = `subtitle-word${isCurrent ? ' is-current' : ''}`;
    span.textContent = text;
    target.appendChild(span);
    target.appendChild(document.createTextNode(' '));
  });
}
