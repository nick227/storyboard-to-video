// Short, deliberately small stopword list -- storyboard beats are simple sentences ("A woman turns
// and throws a ball at the door"), not prose, so a heavy NLP list isn't needed to strip the
// grammatical scaffolding around the 4-5 words that actually describe the subject.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from',
  'into', 'onto', 'through', 'while', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'this', 'that', 'these', 'those', 'her', 'his', 'their', 'its', 'his', 'she', 'he', 'they', 'it',
  'them', 'who', 'which', 'what', 'when', 'where', 'then', 'than', 'so', 'if', 'not', 'no', 'up',
  'down', 'out', 'over', 'under', 'again', 'just', 'own', 'same', 'too', 'very', 'can', 'will',
]);

// Built-in style ids -> a short, Pixabay-searchable visual keyword. Custom styles have no such
// mapping (nothing to look up), so they fall back to the first word of the style's own title.
const STYLE_KEYWORDS = {
  'basic-cartoon': 'cartoon',
  'cinematic-reality': 'cinematic',
  'corporate-presentation': 'corporate',
  'dark-gothic': 'gothic',
  'indie-youtuber': 'vlog',
  'vox-style': 'pop art',
};

function styleKeyword(styleId, styleTitle) {
  if (STYLE_KEYWORDS[styleId]) return STYLE_KEYWORDS[styleId];
  const firstWord = String(styleTitle || '').trim().split(/\s+/)[0] || '';
  return firstWord.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function subjectTerms(scenePrompt, maxTerms) {
  const words = String(scenePrompt || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
  const seen = new Set();
  const unique = [];
  for (const word of words) {
    if (seen.has(word)) continue;
    seen.add(word);
    unique.push(word);
  }
  return unique.slice(0, maxTerms);
}

// Returns queries to try in order: the full style + up to 5 subject terms first (~6 terms total,
// matching how forgiving Pixabay's search is with multi-word queries), then progressively narrower
// fallbacks. Callers only need to move past index 0 when a search actually returns zero results.
function composeStockQueries({ scenePrompt, styleId, styleTitle }) {
  const style = styleKeyword(styleId, styleTitle);
  const subjects = subjectTerms(scenePrompt, 5);
  const join = (terms) => terms.filter(Boolean).join(' ').trim();

  const candidates = [
    join([style, ...subjects]),
    subjects.length > 2 ? join([style, ...subjects.slice(0, 2)]) : null,
    subjects[0] ? join([style, subjects[0]]) : null,
    subjects[0] || null,
    style || null,
  ];

  return [...new Set(candidates.filter(Boolean))];
}

module.exports = { composeStockQueries };
