const { AppError } = require('../errors');
const { cleanText } = require('../shared/text');

function signal(timeoutMs, getCancellation) { const timeout = AbortSignal.timeout(Number(timeoutMs) || 120_000); const active = getCancellation?.(); return active ? AbortSignal.any([timeout, active]) : timeout; }
function providerError(provider, status, detail = '', retryAfter = '') {
  const name = provider.charAt(0).toUpperCase() + provider.slice(1); let message;
  if (status === 429) message = `${name} API quota exceeded. Enable billing or request more quota for the configured API key, or select another provider.`;
  else if (status === 401 || status === 403) message = `${name} rejected the configured API key. Check the key, project access, and billing settings.`;
  else message = `${name} provider error (${status})${detail ? `: ${cleanText(detail, 500)}` : ''}`;
  const error = new AppError('PROVIDER_ERROR', message, { status: status === 429 ? 429 : 502, retryable: status >= 500 }); error.retryAfter = retryAfter; return error;
}
async function throwResponse(provider, response) { const raw = await response.text(); let detail = raw; try { const value = JSON.parse(raw); detail = value?.error?.message || value?.message || raw; } catch (_) {} throw providerError(provider, response.status, detail, response.headers.get('retry-after') || ''); }
module.exports = { providerError, signal, throwResponse };
