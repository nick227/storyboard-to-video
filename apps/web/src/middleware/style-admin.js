const { AppError } = require('../errors');

function bootstrapAdmin(req) {
  const configured = String(process.env.ADMIN_OWNER_IDS || '').split(',').map((value) => value.trim()).filter(Boolean);
  const allowed = configured.length ? configured : (process.env.NODE_ENV === 'production' ? [] : ['local-user']);
  return allowed.includes(req.auth?.legacyId) || allowed.includes(req.auth?.userId);
}

function isPlatformAdmin(req) {
  return ['admin', 'super_admin'].includes(req.auth?.platformRole || req.user?.platformRole) || bootstrapAdmin(req);
}

function styleAdmin(req, res, next) {
  return isPlatformAdmin(req) ? next() : next(new AppError('FORBIDDEN', 'Platform administration is not permitted', { status: 403 }));
}

module.exports = { bootstrapAdmin, isPlatformAdmin, styleAdmin };
