import { api } from '../api.js';

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

export async function fetchPublicScripts() {
  return (await publicJson('/api/public/scripts')).scripts || [];
}

export async function fetchPublicScript(slug) {
  return (await publicJson(`/api/public/scripts/${encodeURIComponent(slug)}`)).script;
}

export async function fetchCategories() {
  return (await publicJson('/api/public/scripts/categories')).categories || [];
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
