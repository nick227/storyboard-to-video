const DEFAULT_MAX_CHARS_PER_LINE = 40;
const DEFAULT_MAX_LINES_PER_CUE = 2;
const DEFAULT_MIN_CUE_DURATION_SEC = 1.0;
const DEFAULT_MAX_CUE_DURATION_SEC = 6.0;
const MAX_GAP_TO_EXTEND_SEC = 0.5;

function isSentenceEnd(word) { return /[.!?]["')\]]?$/.test(word.text); }

// Greedy line wrap; never drops words -- overflow beyond maxLines merges into the final line
// rather than truncating.
function wrapIntoLines(text, maxCharsPerLine, maxLines) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && candidate.length > maxCharsPerLine) { lines.push(line); line = word; }
    else line = candidate;
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines - 1), lines.slice(maxLines - 1).join(' ')];
}

// Greedy word accumulation into cues, breaking on char-budget overflow, duration overflow, or an
// audible pause since the last word. A sentence-ending word additionally force-flushes once the
// cue already has a reasonable amount of text, so back-to-back short sentences with no real pause
// don't get merged into one over-long cue.
function groupWordsIntoCues(words, options = {}) {
  if (!words?.length) return [];
  const maxCharsPerLine = options.maxCharsPerLine || DEFAULT_MAX_CHARS_PER_LINE;
  const maxLines = options.maxLines || DEFAULT_MAX_LINES_PER_CUE;
  const maxCharsPerCue = maxCharsPerLine * maxLines;
  const minDuration = options.minCueDuration ?? DEFAULT_MIN_CUE_DURATION_SEC;
  const maxDuration = options.maxCueDuration ?? DEFAULT_MAX_CUE_DURATION_SEC;

  const rawCues = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    rawCues.push({ words: current, start: current[0].start, end: current[current.length - 1].end });
    current = [];
  };

  for (const word of words) {
    if (current.length) {
      const prospectiveText = [...current, word].map((w) => w.text).join(' ');
      const prospectiveDuration = word.end - current[0].start;
      const gap = word.start - current[current.length - 1].end;
      if (prospectiveText.length > maxCharsPerCue || prospectiveDuration > maxDuration || gap > MAX_GAP_TO_EXTEND_SEC) {
        flush();
      }
    }
    current.push(word);
    const accumulatedText = current.map((w) => w.text).join(' ');
    if (isSentenceEnd(word) && accumulatedText.length >= maxCharsPerLine) flush();
  }
  flush();

  // Enforce a minimum readable duration without ever overlapping the next cue's start.
  for (let i = 0; i < rawCues.length; i += 1) {
    const nextStart = i + 1 < rawCues.length ? rawCues[i + 1].start : Infinity;
    const desiredEnd = rawCues[i].start + minDuration;
    rawCues[i].end = Math.min(Math.max(rawCues[i].end, desiredEnd), Math.max(rawCues[i].end, nextStart - 0.05));
  }

  return rawCues.map((cue, i) => {
    const text = cue.words.map((w) => w.text).join(' ');
    const lines = wrapIntoLines(text, maxCharsPerLine, maxLines);
    return { index: i + 1, start: cue.start, end: cue.end, lines, text: lines.join('\n') };
  });
}

function formatSrtTimestamp(seconds) {
  const totalMs = Math.round(Math.max(0, seconds) * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

function buildSrt(cues) {
  return cues.map((cue, i) => [
    String(i + 1),
    `${formatSrtTimestamp(cue.start)} --> ${formatSrtTimestamp(cue.end)}`,
    cue.lines.join('\n'),
    '',
  ].join('\n')).join('\n');
}

module.exports = { groupWordsIntoCues, wrapIntoLines, buildSrt, formatSrtTimestamp };
