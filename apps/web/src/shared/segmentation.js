const { clampSceneCount, cleanText, compactAction } = require('./text');

function splitIntoFragments(scriptText, sceneCount) {
  const count = clampSceneCount(sceneCount);
  const source = cleanText(scriptText, 200_000);
  if (!source) return [];

  // Try splitting on newlines first
  let blocks = source.split('\n').map((line) => line.trim()).filter(Boolean);

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
