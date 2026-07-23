import { RawScriptAdapter } from './screenplay-editor/js/adapters/RawScriptAdapter.js';
import { fetchPublicScript } from './scripts-public-api.js';

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderBody(scriptText = '') {
  return RawScriptAdapter.parse(scriptText, 'fountain').lines.map((line) => (
    `<p class="${escapeHtml(line.format)}">${escapeHtml(line.content.trim())}</p>`
  )).join('\n');
}

const slug = decodeURIComponent(window.location.pathname.replace(/^\/scripts\//, '').replace(/\/$/, ''));
const status = document.getElementById('readerStatus');
const article = document.getElementById('readerArticle');

try {
  const script = await fetchPublicScript(slug);
  document.title = `${script.title || 'Script'} — Storyboarder`;
  document.getElementById('readerTitle').textContent = script.title || 'Untitled';
  document.getElementById('readerAuthor').textContent = `by ${script.author || 'Anonymous'}`;
  document.getElementById('readerBody').innerHTML = renderBody(script.scriptText || '');
  status.hidden = true;
  article.hidden = false;
} catch (error) {
  status.dataset.tone = 'error';
  status.textContent = error.code === 'SCRIPT_NOT_FOUND' ? 'Script not found.' : (error.message || 'Failed to load script.');
}
