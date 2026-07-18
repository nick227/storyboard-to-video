function slugify(input = '') { return String(input).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item'; }
function cleanText(value, maxLength) { return String(value || '').trim().slice(0, maxLength); }
function clampSceneCount(value) { const count = Number.parseInt(value, 10); return Number.isFinite(count) ? Math.min(50, Math.max(1, count)) : 6; }
function getAdditionalCommonPrompt(stylePrompt, commonPrompt, max = 20_000) {
  const style = cleanText(stylePrompt, max); const common = cleanText(commonPrompt, max);
  if (!style || !common) return common;
  if (common === style) return '';
  return common.startsWith(style) ? common.slice(style.length).trim() : common;
}
function extractJson(text) { if (!text) return null; try { return JSON.parse(text); } catch (_) {} const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/); if (!match) return null; try { return JSON.parse(match[0]); } catch (_) { return null; } }
function compactWords(value, maxWords) {
  return cleanText(value, 5_000).split(/\s+/).filter(Boolean).slice(0, maxWords).join(' ');
}
function compactAction(value, fallback = 'Subject moves.') {
  return compactWords(value, 24) || fallback;
}
module.exports = { clampSceneCount, cleanText, extractJson, getAdditionalCommonPrompt, slugify, compactWords, compactAction };
