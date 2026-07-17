const { cleanText } = require('./text');

const NEIGHBOR_BEAT_MAX_LENGTH = 300;

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

function neighborContextBlock(previousBeat, nextBeat) {
  const parts = [
    previousBeat ? `Previous scene's action: ${cleanText(previousBeat, NEIGHBOR_BEAT_MAX_LENGTH)}.` : '',
    nextBeat ? `Next scene's action: ${cleanText(nextBeat, NEIGHBOR_BEAT_MAX_LENGTH)}.` : '',
  ].filter(Boolean).join(' ');
  return parts ? `Neighboring context for continuity only (do not copy verbatim): ${parts}` : '';
}

module.exports = { NEIGHBOR_BEAT_MAX_LENGTH, chunk, neighborContextBlock };
