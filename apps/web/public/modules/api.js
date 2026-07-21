export async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  
  if (options.method === 'POST' && /^\/api\/(storyboard\/(generate|regenerate|plan-shots|split-scene)|images\/generate|videos\/generate|audio\/(generate|recordings)|subtitles\/generate)/.test(url)) {
    headers['Idempotency-Key'] ||= options.idempotencyKey || crypto.randomUUID();
  }
  
  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const fetchOptions = options;
  const res = await fetch(url, { ...fetchOptions, headers });
  
  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_) {
    throw new Error(`Request failed with status ${res.status}`);
  }

  if (!res.ok) {
    const detail = data.error && typeof data.error === 'object' ? data.error : null;
    const error = new Error(detail?.message || data.error || `Request failed with status ${res.status}`);
    error.code = detail?.code || 'REQUEST_FAILED';
    error.retryable = detail?.retryable === true;
    error.status = res.status;
    
    if (res.status === 401) window.dispatchEvent(new CustomEvent('storyboard:unauthenticated'));
    throw error;
  }
  
  return data;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().flatMap((key) => value[key] === undefined ? [] : [[key, canonicalize(value[key])]]));
  return value;
}

// A logical operation keeps the same key when a batch resumes after a lost HTTP response, while
// the caller's version counter makes an intentional later regeneration a new operation.
export async function logicalIdempotencyKey(namespace, value) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `generation:${String(namespace).replace(/[^a-zA-Z0-9_.:-]/g, '_')}:${hex}`;
}

export async function cancelActiveProjectJobs(projectId) {
  if (!projectId) return;
  try {
    const data = await api(`/api/jobs?projectId=${encodeURIComponent(projectId)}`);
    const active = (data.jobs || []).filter((job) => ['queued', 'running'].includes(job.status));
    await Promise.all(active.map((job) => api(`/api/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' }).catch(() => null)));
  } catch (_) {}
}
