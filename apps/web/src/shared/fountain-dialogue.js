const FOUNTAIN_HEADER_REGEX = /^(?:INT\.|EXT\.|INT\/EXT\.|I\/E\.|EST\.|^\.[A-Z0-9])/i;

function parseSpeakerLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return null;

  let isForced = false;
  let working = trimmed;

  if (working.startsWith('@')) {
    isForced = true;
    working = working.slice(1).trim();
  }

  let isDualDialogue = false;
  if (working.endsWith('^')) {
    isDualDialogue = true;
    working = working.slice(0, -1).trim();
  }

  let modifier = null;
  const modifierMatch = working.match(/\s*\(([^)]+)\)\s*$/);
  if (modifierMatch) {
    modifier = modifierMatch[1].trim();
    working = working.slice(0, modifierMatch.index).trim();
  }

  if (!isForced) {
    if (!working || working !== working.toUpperCase() || /[a-z]/.test(working) || working.length > 60) {
      return null;
    }
  }

  return {
    character: working,
    rawSpeaker: trimmed,
    modifier,
    isDualDialogue,
    isVoiceOver: Boolean(modifier && /V\.?O\.?/i.test(modifier)),
    isOffScreen: Boolean(modifier && /O\.?S\.?/i.test(modifier)),
  };
}

function parseFountainDialogue(scriptText = '') {
  if (!scriptText || typeof scriptText !== 'string') return [];

  const lines = scriptText.split(/\r?\n/);
  const entries = [];

  let currentEntry = null;
  let prevLineWasBlank = true;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (trimmed === '') {
      if (currentEntry) {
        if (currentEntry.lines.length > 0) {
          currentEntry.text = currentEntry.lines.join(' ');
          entries.push(currentEntry);
        }
        currentEntry = null;
      }
      prevLineWasBlank = true;
      continue;
    }

    if (FOUNTAIN_HEADER_REGEX.test(trimmed)) {
      if (currentEntry) {
        if (currentEntry.lines.length > 0) {
          currentEntry.text = currentEntry.lines.join(' ');
          entries.push(currentEntry);
        }
        currentEntry = null;
      }
      prevLineWasBlank = false;
      continue;
    }

    if (prevLineWasBlank) {
      const speakerMeta = parseSpeakerLine(trimmed);
      if (speakerMeta) {
        if (currentEntry && currentEntry.lines.length > 0) {
          currentEntry.text = currentEntry.lines.join(' ');
          entries.push(currentEntry);
        }
        currentEntry = {
          character: speakerMeta.character,
          rawSpeaker: speakerMeta.rawSpeaker,
          modifier: speakerMeta.modifier,
          isDualDialogue: speakerMeta.isDualDialogue,
          isVoiceOver: speakerMeta.isVoiceOver,
          isOffScreen: speakerMeta.isOffScreen,
          parentheticals: [],
          lines: [],
          text: '',
        };
        prevLineWasBlank = false;
        continue;
      }
    }

    if (currentEntry) {
      if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
        const parenContent = trimmed.slice(1, -1).trim();
        if (parenContent) currentEntry.parentheticals.push(parenContent);
      } else {
        currentEntry.lines.push(trimmed);
      }
    }

    prevLineWasBlank = false;
  }

  if (currentEntry && currentEntry.lines.length > 0) {
    currentEntry.text = currentEntry.lines.join(' ');
    entries.push(currentEntry);
  }

  return entries;
}

module.exports = { parseFountainDialogue, parseSpeakerLine };
