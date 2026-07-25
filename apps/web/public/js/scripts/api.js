import { api } from '../core/api.js';

async function publicJson(url) {
  const response = await fetch(url, { credentials: 'same-origin' });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 404) {
    const error = new Error(payload?.error?.message || 'Not found');
    error.code = payload?.error?.code || 'NOT_FOUND';
    error.status = 404;
    throw error;
  }
  if (!response.ok) throw new Error(payload?.error?.message || 'Request failed');
  return payload;
}

export async function fetchPublicScripts({
  artifact = 'all',
  category = '',
  tag = '',
} = {}) {
  const params = new URLSearchParams();
  if (artifact) params.set('artifact', artifact);
  if (category) params.set('category', category);
  if (tag) params.set('tag', tag);
  const query = params.toString();
  return (await publicJson(`/api/public/scripts${query ? `?${query}` : ''}`)).scripts || [];
}

export async function fetchPublicScript(slug, { artifact = 'screenplay' } = {}) {
  const params = new URLSearchParams();
  if (artifact && artifact !== 'screenplay') params.set('artifact', artifact);
  const query = params.toString();
  return (await publicJson(`/api/public/scripts/${encodeURIComponent(slug)}${query ? `?${query}` : ''}`)).script;
}

export async function fetchCategories({ onlyWithScripts = false } = {}) {
  const query = onlyWithScripts ? '?onlyWithScripts=true' : '';
  return (await publicJson(`/api/public/scripts/categories${query}`)).categories || [];
}

export async function fetchTags() {
  return (await publicJson('/api/public/scripts/tags')).tags || [];
}

export async function fetchScriptsByCategory(slug) {
  return (await publicJson(`/api/public/scripts/category/${encodeURIComponent(slug)}`)).scripts || [];
}

export async function fetchScriptsByTag(slug) {
  return (await publicJson(`/api/public/scripts/tag/${encodeURIComponent(slug)}`)).scripts || [];
}

export async function fetchWriter(profileSlug) {
  return (await publicJson(`/api/public/writers/${encodeURIComponent(profileSlug)}`)).writer;
}

export async function toggleScriptLike(scriptId) {
  return api(`/api/scripts/${encodeURIComponent(scriptId)}/like`, { method: 'POST', body: '{}' });
}

export async function toggleFollowWriter(userId) {
  return api(`/api/writers/${encodeURIComponent(userId)}/follow`, { method: 'POST', body: '{}' });
}

export async function fetchScriptStats(scriptId) {
  return api(`/api/scripts/${encodeURIComponent(scriptId)}/stats`);
}

export async function updateScriptMeta(scriptId, body) {
  return api(`/api/scripts/${encodeURIComponent(scriptId)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}
