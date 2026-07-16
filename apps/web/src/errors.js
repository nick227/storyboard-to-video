const { ZodError } = require('zod');

class AppError extends Error {
  constructor(code, message, { status = 500, retryable = false, details, cause } = {}) {
    super(message, { cause });
    this.name = 'AppError';
    this.code = code;
    this.statusCode = status;
    this.retryable = retryable;
    this.details = details;
  }
}

function errorPayload(error, requestId) {
  const validation = error instanceof ZodError;
  return {
    ok: false,
    error: {
      code: validation ? 'VALIDATION_ERROR' : (error.code || 'INTERNAL_ERROR'),
      message: validation ? 'Request validation failed' : (error.message || 'Unexpected server error'),
      retryable: validation ? false : error.retryable === true,
      ...(validation ? { details: error.issues } : error.details ? { details: error.details } : {}),
      ...(requestId ? { requestId } : {}),
    },
  };
}

function errorMiddleware(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (error.retryAfter) res.set('Retry-After', error.retryAfter);
  const status = error instanceof ZodError ? 400 : (error.statusCode || 500);
  return res.status(status).json(errorPayload(error, req.id));
}

function notFound(req, res) {
  return res.status(404).json(errorPayload(new AppError('NOT_FOUND', 'Route not found', { status: 404 }), req.id));
}

module.exports = { AppError, errorMiddleware, errorPayload, notFound };
