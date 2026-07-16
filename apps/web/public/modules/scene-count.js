export function suggestSceneCount(scriptText) {
  const script = String(scriptText || '').trim();
  if (!script) return 1;

  const words = script.match(/\S+/g)?.length || 0;
  const sentences = script.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g)?.length || 1;
  const paragraphs = script.split(/\n\s*\n/).filter((part) => part.trim()).length;
  const screenplayHeadings = script.match(/^\s*(?:INT\.?|EXT\.?|INT\.?\/EXT\.?|I\/E)\s+/gim)?.length || 0;

  const pacingEstimate = Math.max(1, Math.round(words / 40));
  const actionEstimate = Math.max(1, Math.round(sentences / 2));
  const paragraphEstimate = screenplayHeadings ? 1 : Math.min(paragraphs, Math.max(1, Math.ceil(words / 15)));

  return Math.min(50, Math.max(pacingEstimate, actionEstimate, paragraphEstimate, screenplayHeadings));
}
