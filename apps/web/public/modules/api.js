export async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  headers.Authorization ||= `Bearer ${localStorage.getItem('storyboard-auth-token') || 'local-dev-token'}`;
  
  if (options.method === 'POST' && /^\/api\/(storyboard\/(generate|regenerate)|images\/generate|videos\/generate|audio\/generate)/.test(url)) {
    headers['Idempotency-Key'] ||= options.idempotencyKey || crypto.randomUUID();
  }
  
  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const { authRetried, ...fetchOptions } = options;
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
    
    if (res.status === 401 && !authRetried) {
      const token = window.prompt('Enter the project API access token:');
      if (token) {
        localStorage.setItem('storyboard-auth-token', token);
        return api(url, { ...options, authRetried: true, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } });
      }
    }
    throw error;
  }
  
  return data;
}

export async function cancelActiveProjectJobs(projectId) {
  if (!projectId) return;
  try {
    const data = await api(`/api/jobs?projectId=${encodeURIComponent(projectId)}`);
    const active = (data.jobs || []).filter((job) => ['queued', 'running'].includes(job.status));
    await Promise.all(active.map((job) => api(`/api/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' }).catch(() => null)));
  } catch (_) {}
}
