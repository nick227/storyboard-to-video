function slugify(input = '') { return String(input).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item'; }
// Matches the auto-assigned slug a script gets while its project is still titled "Untitled".
// Used to resync the slug from the title exactly once (placeholder -> real slug), then leave it alone.
function isPlaceholderSlug(slug) { return /^untitled(-\d+)?$/.test(String(slug || '')); }
function cleanText(value, maxLength) { return String(value || '').trim().slice(0, maxLength); }
function clampSceneCount(value) { const count = Number.parseInt(value, 10); return Number.isFinite(count) ? Math.min(50, Math.max(1, count)) : 6; }
function getAdditionalCommonPrompt(stylePrompt, commonPrompt, max = 20_000) {
  const style = cleanText(stylePrompt, max); const common = cleanText(commonPrompt, max);
  if (!style || !common) return common;
  if (common === style) return '';
  return common.startsWith(style) ? common.slice(style.length).trim() : common;
}
function extractJson(text) { if (!text) return null; try { return JSON.parse(text); } catch (_) {} const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/); if (!match) return null; try { return JSON.parse(match[0]); } catch (_) { return null; } }
function readTextField(value, preferredKeys = [], maxLength) {
  if (typeof value === 'string') return cleanText(value, maxLength);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  for (const key of preferredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const nested = readTextField(value[key], preferredKeys, maxLength);
    if (nested) return nested;
  }
  return '';
}
/** Parse provider JSON and pull the first usable string from preferred keys (or a bare JSON string). */
function extractTextField(raw, preferredKeys = ['prompt'], maxLength = 20_000) {
  const parsed = extractJson(raw);
  if (parsed == null) return '';
  if (typeof parsed === 'string') return cleanText(parsed, maxLength);
  return readTextField(parsed, preferredKeys, maxLength);
}
function compactWords(value, maxWords) {
  return cleanText(value, 5_000).split(/\s+/).filter(Boolean).slice(0, maxWords).join(' ');
}
function compactAction(value, fallback = 'Subject moves.') {
  return compactWords(value, 28) || fallback;
}
module.exports = { clampSceneCount, cleanText, extractJson, extractTextField, getAdditionalCommonPrompt, isPlaceholderSlug, slugify, compactWords, compactAction };
