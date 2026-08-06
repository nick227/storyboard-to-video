const { z } = require('zod');
const { AppError } = require('../errors');
const { cleanText, extractJson } = require('../shared/text');
const { providerOutput } = require('../providers/result');

// Only the tail of the script is fed into either prompt -- chat is meant to discuss the whole
// screenplay conversationally (a full read isn't needed to answer most questions), and continuation
// only needs enough context to pick up tone/characters/location where the script currently ends.
const CHAT_SCRIPT_TAIL_LENGTH = 20_000;
const CONTINUATION_SCRIPT_TAIL_LENGTH = 6_000;
const CHAT_REPLY_MAX_LENGTH = 4_000;
const ADDED_TEXT_MAX_LENGTH = 6_000;
// Keep recent turns only so long sessions don't drown the cover brief / script tail.
const CHAT_HISTORY_WINDOW = 12;

const chatResponseSchema = z.object({ reply: z.string() });
const continuationResponseSchema = z.object({ addedText: z.string() });

function scriptExcerpt(scriptText, maxLength) {
  const text = String(scriptText || '').trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `[Earlier screenplay content omitted — showing the most recent portion only.]\n${text.slice(-maxLength)}`;
}

function windowMessages(messages = [], limit = CHAT_HISTORY_WINDOW) {
  const list = Array.isArray(messages) ? messages : [];
  return list.length > limit ? list.slice(-limit) : list;
}

function historyBlock(messages) {
  return messages
    .map((message) => `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`)
    .join('\n');
}

// Mirrors apps/web/public/js/screenplay-editor/js/adapters/FountainAdapter.js's toDocument() line
// classifier exactly (kept in sync manually -- the editor module is ESM, this service is CommonJS,
// so it can't be required directly). That classifier is sequence-based, not blank-line-based: a
// character cue is only recognized when the immediately preceding line's format is null/header/
// action. The real corruption risk isn't a missing blank line between a cue and ITS OWN dialogue
// (dialogue must stay adjacent to its cue to be recognized at all) -- it's a missing blank line
// between one character's dialogue and the NEXT character's cue, which silently demotes the next
// cue to an ACTION line and merges two characters' lines together.
const HEADER_RE = /^(INT\.|EXT\.|INT\/EXT\.|I\/E\.|EST\.)/i;
const TRANSITION_RE = /^(FADE (IN|OUT|TO BLACK)|CUT TO|DISSOLVE TO|SMASH CUT TO|MATCH CUT TO|WIPE TO|IRIS (IN|OUT)|TO BLACK)[:.]?$/i;

function isTransitionLine(trimmed) {
  if (TRANSITION_RE.test(trimmed)) return true;
  return trimmed === trimmed.toUpperCase() && !/[a-z]/.test(trimmed) && / TO:$/.test(trimmed) && trimmed.length < 40;
}

function classifyFountainLine(trimmed, prevFormat) {
  if (HEADER_RE.test(trimmed)) return 'header';
  if (isTransitionLine(trimmed)) return 'transition';
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) return 'directions';
  if (trimmed === trimmed.toUpperCase() && !/[a-z]/.test(trimmed) && trimmed.length < 40
    && (prevFormat == null || prevFormat === 'header' || prevFormat === 'action')) return 'speaker';
  if (prevFormat === 'speaker' || prevFormat === 'directions') return 'dialog';
  return 'action';
}

// Best-effort normalization, not a hard parser gate -- always runs before injection, per the
// "auto-normalize then inject" decision. Uppercases scene headings/character cues/transitions
// (case-insensitive to this app's own classifier, but other exports/tools expect it) and inserts
// blank lines exactly where the classifier above needs them to avoid misreading the model's intent.
function normalizeFountainContinuation(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const output = [];
  let prevFormat = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (output.length && output[output.length - 1] !== '') output.push('');
      prevFormat = null;
      continue;
    }

    let format = classifyFountainLine(trimmed, prevFormat);
    // A fresh candidate cue or a plain line landing right after a dialogue block both need a
    // separating blank line -- without it the classifier folds them into the prior block instead
    // of starting a new one (see comment above).
    const exitingDialogueBlock = format === 'action' && (prevFormat === 'speaker' || prevFormat === 'directions' || prevFormat === 'dialog');
    const needsBlankBefore = output.length > 0 && output[output.length - 1] !== ''
      && (format === 'header' || format === 'transition' || exitingDialogueBlock);
    if (needsBlankBefore) {
      output.push('');
      prevFormat = null;
      format = classifyFountainLine(trimmed, prevFormat);
    }

    const content = (format === 'header' || format === 'speaker' || format === 'transition') ? trimmed.toUpperCase() : trimmed;
    output.push(content);
    prevFormat = format;
  }

  return output.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
}

function summaryBlock(summary, { hasBody = false } = {}) {
  const text = String(summary || '').trim();
  if (!text) return '';
  const usage = hasBody
    ? `- The screenplay body exists: stay consistent with this bible and prefer advancing its next unresolved beat.
- Do not invent a conflicting premise, genre, central conflict, or ending.`
    : `- The screenplay body is empty: treat this bible as the sole brief for discussion and for any drafting the writer requests.
- Do not invent a conflicting premise, genre, or central conflict.`;
  return `Story bible (authoritative):
${text}

Rules for using the bible:
${usage}
`;
}

function buildChatRequest({ scriptText, summary, messages, userMessage }) {
  const hasBody = Boolean(String(scriptText || '').trim());
  const hasSummary = Boolean(String(summary || '').trim());
  const emptyGuidance = !hasBody && hasSummary
    ? 'The screenplay body is empty. Ground every answer in the story bible above — outline beats, characters, and opening strategy from it unless the writer asks otherwise.'
    : !hasBody
      ? 'The screenplay body is empty. Ask for or wait on a story bible/summary before inventing a full premise, unless the writer supplies one in chat.'
      : '';
  const recent = windowMessages(messages);
  const omitted = Array.isArray(messages) && messages.length > recent.length
    ? `(${messages.length - recent.length} earlier turn${messages.length - recent.length === 1 ? '' : 's'} omitted.)\n`
    : '';

  return `Return strict JSON only: {"reply":"..."}. You are a screenwriting assistant helping a writer discuss and improve their screenplay. Answer conversationally and helpfully. Never silently rewrite or replace the screenplay -- only discuss it, unless the writer explicitly asks you to draft replacement text within your reply.

${summaryBlock(summary, { hasBody })}${emptyGuidance ? `${emptyGuidance}\n\n` : ''}Current screenplay:
${scriptExcerpt(scriptText, CHAT_SCRIPT_TAIL_LENGTH) || '(empty screenplay)'}

${recent.length ? `Conversation so far:\n${omitted}${historyBlock(recent)}\n` : ''}User: ${userMessage}`;
}

function buildContinuationRequest({ scriptText, summary, lineCount }) {
  const hasBody = Boolean(String(scriptText || '').trim());
  const hasSummary = Boolean(String(summary || '').trim());
  const continuity = hasBody
    ? 'Preserve the established characters, tone, and location from the excerpt unless the story naturally moves on (e.g. a scene heading change). If a story bible is present, advance its next unresolved beat and do not contradict its premise.'
    : hasSummary
      ? 'The screenplay body is empty. Use the story bible as the primary brief and begin the screenplay from scratch in Fountain format.'
      : 'The screenplay body is empty. Begin the screenplay from scratch in Fountain format.';
  return `Return strict JSON only: {"addedText":"..."}. Continue this screenplay in Fountain format.

Rules:
1. Write only NEW content that comes after the excerpt below -- never repeat or rephrase existing lines.
2. Target approximately ${lineCount} printed lines, counting every scene heading, character cue, parenthetical, and dialogue or action line separately (a multi-line dialogue speech counts as several lines, not one). This is a soft guideline, not a hard requirement to satisfy exactly.
3. Use standard Fountain conventions: scene headings like "INT. LOCATION - DAY" or "EXT. LOCATION - NIGHT", character cues in ALL CAPS on their own line, parentheticals in parentheses, plain dialogue lines, and transitions like "CUT TO:" where appropriate. Always leave a blank line between one character's dialogue and the next character's cue.
4. ${continuity}
5. Do not include any commentary, explanation, or markdown -- addedText must be raw screenplay text only.

${summaryBlock(summary, { hasBody })}Excerpt (end of the current screenplay):
${scriptExcerpt(scriptText, CONTINUATION_SCRIPT_TAIL_LENGTH) || '(empty screenplay -- begin the story)'}`;
}

function createScreenplayAssistantService({ textProviders }) {
  async function chat({ scriptText, summary = '', messages = [], userMessage, provider, fallbackPolicy = 'local' }) {
    if (provider === 'stub') return { reply: 'Stub text mode selected; the assistant is unavailable.', usedFallback: true, warning: 'Stub text mode selected; the assistant is unavailable.' };

    try {
      const request = buildChatRequest({ scriptText, summary, messages, userMessage });
      const parsed = chatResponseSchema.parse(extractJson(providerOutput(await textProviders.call(provider, request))));
      const reply = cleanText(parsed.reply, CHAT_REPLY_MAX_LENGTH);
      if (!reply) throw new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned an empty reply', { status: 502 });
      return { reply, usedFallback: false, warning: '' };
    } catch (error) {
      if (fallbackPolicy !== 'local') throw (error instanceof AppError ? error : new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned an invalid reply', { status: 502, cause: error }));
      return { reply: 'The assistant is temporarily unavailable. Your message was saved.', usedFallback: true, warning: `Provider unavailable; a placeholder reply was returned. ${cleanText(error.message, 300)}` };
    }
  }

  async function addNextLines({ scriptText, summary = '', lineCount = 10, provider, fallbackPolicy = 'local' }) {
    if (provider === 'stub') return { addedText: '', usedFallback: true, warning: 'Stub text mode selected; no continuation was generated.' };

    try {
      const request = buildContinuationRequest({ scriptText, summary, lineCount });
      const parsed = continuationResponseSchema.parse(extractJson(providerOutput(await textProviders.call(provider, request))));
      const cleaned = cleanText(parsed.addedText, ADDED_TEXT_MAX_LENGTH);
      if (!cleaned) throw new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned an empty continuation', { status: 502 });
      const addedText = normalizeFountainContinuation(cleaned);
      return { addedText, usedFallback: false, warning: '' };
    } catch (error) {
      if (fallbackPolicy !== 'local') throw (error instanceof AppError ? error : new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned an invalid continuation', { status: 502, cause: error }));
      return { addedText: '', usedFallback: true, warning: `Provider unavailable; no continuation was generated. ${cleanText(error.message, 300)}` };
    }
  }

  return { chat, addNextLines };
}

module.exports = {
  createScreenplayAssistantService,
  normalizeFountainContinuation,
  windowMessages,
  CHAT_HISTORY_WINDOW,
};
