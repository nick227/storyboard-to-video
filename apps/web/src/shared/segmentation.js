const { clampSceneCount, cleanText, compactAction } = require('./text');

const FOUNTAIN_HEADING_REGEX = /^\s*(?:INT\.|EXT\.|INT\/EXT\.|I\/E\.|EST\.|^\.[A-Z0-9])/i;

function parseFountainSceneBlocks(source) {
  const lines = source.split('\n');
  const hasHeadings = lines.some((line) => FOUNTAIN_HEADING_REGEX.test(line.trim()));
  if (!hasHeadings) return null;

  const blocks = [];
  let currentBlockLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (FOUNTAIN_HEADING_REGEX.test(trimmed)) {
      if (currentBlockLines.length > 0) {
        const text = currentBlockLines.join('\n').trim();
        if (text) blocks.push(text);
      }
      currentBlockLines = [trimmed];
    } else {
      if (trimmed || currentBlockLines.length > 0) {
        currentBlockLines.push(line);
      }
    }
  }

  if (currentBlockLines.length > 0) {
    const text = currentBlockLines.join('\n').trim();
    if (text) blocks.push(text);
  }

  return blocks.length > 0 ? blocks : null;
}

function splitIntoFragments(scriptText, sceneCount) {
  const count = clampSceneCount(sceneCount);
  const source = cleanText(scriptText, 200_000);
  if (!source) return [];

  let blocks = parseFountainSceneBlocks(source);

  if (!blocks) {
    // Try splitting on newlines first
    blocks = source.split('\n').map((line) => line.trim()).filter(Boolean);

    // Fallback to period splitting if the requested count cannot be satisfied by newlines alone
    if (blocks.length < count) {
      blocks = source.split('.')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => {
          if (item.endsWith('.') || item.endsWith('?') || item.endsWith('!')) return item;
          return item + '.';
        });
    }
  }

  if (!blocks.length) return [];

  const achievableCount = Math.min(count, blocks.length);
  return Array.from({ length: achievableCount }, (_, index) => {
    const start = Math.floor(index * blocks.length / achievableCount);
    const end = Math.max(start + 1, Math.floor((index + 1) * blocks.length / achievableCount));
    const scriptFragment = cleanText(blocks.slice(start, end).join(' '), 20_000);
    return { sceneNumber: index + 1, scriptFragment };
  });
}

function fallbackSceneFromFragment(fragment, index) {
  const beat = compactAction(fragment.scriptFragment);
  return {
    sceneNumber: fragment.sceneNumber,
    title: `Scene ${index + 1}`,
    scriptFragment: fragment.scriptFragment,
    beat,
    prompt: `${beat} Clear subject, key pose, readable composition.`,
    promptGeneratedFromBeat: null,
    promptIsFallback: true,
  };
}

function splitSceneIntoScenes(scriptFragment, count, narrationText) {
  const splitAndMap = (text, n) => splitIntoFragments(text, n).map(fallbackSceneFromFragment);
  return splitAndMap(scriptFragment, count);
}

module.exports = { splitIntoFragments, fallbackSceneFromFragment, splitSceneIntoScenes };
