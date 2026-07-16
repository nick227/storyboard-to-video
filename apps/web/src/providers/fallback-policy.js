const { AppError } = require('../errors');

async function withFallback(policy, primary, fallback, message) {
  try { return await primary(); }
  catch (cause) {
    if (policy === 'local') return fallback(cause);
    if (cause.statusCode) throw cause;
    throw new AppError('PROVIDER_FAILED', cause.message || message || 'Provider failed', { status: 502, retryable: true, cause });
  }
}

module.exports = { withFallback };
