function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function scriptCoverCard(script) {
  return `<a class="script-cover-card" href="/scripts/${encodeURIComponent(script.slug)}">
    <p class="cover-label">Screenplay</p>
    <h2 class="cover-title">${escapeHtml(script.title || 'Untitled')}</h2>
    <p class="cover-author">${escapeHtml(script.author || 'Anonymous')}</p>
  </a>`;
}

export async function fetchPublicScripts() {
  const response = await fetch('/api/public/scripts');
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || 'Failed to load scripts');
  return payload.scripts || [];
}

export async function fetchPublicScript(slug) {
  const response = await fetch(`/api/public/scripts/${encodeURIComponent(slug)}`);
  const payload = await response.json().catch(() => ({}));
  if (response.status === 404) {
    const error = new Error('Script not found');
    error.code = 'SCRIPT_NOT_FOUND';
    throw error;
  }
  if (!response.ok) throw new Error(payload?.error?.message || 'Failed to load script');
  return payload.script;
}
