import { api } from '../api.js';

export async function fetchPublicScripts() {
  const response = await fetch('/api/public/scripts');
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || 'Failed to load scripts');
  return payload.scripts || [];
}

export async function fetchPublicScript(slug) {
  const response = await fetch(`/api/public/scripts/${encodeURIComponent(slug)}`, {
    credentials: 'same-origin',
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 404) {
    const error = new Error('Script not found');
    error.code = 'SCRIPT_NOT_FOUND';
    throw error;
  }
  if (!response.ok) throw new Error(payload?.error?.message || 'Failed to load script');
  return payload.script;
}

export async function toggleScriptLike(scriptId) {
  return api(`/api/scripts/${encodeURIComponent(scriptId)}/like`, { method: 'POST', body: '{}' });
}
