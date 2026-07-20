const crypto = require('node:crypto');
const argon2 = require('argon2');
const { AppError } = require('./errors');

const SESSION_COOKIE = 'storyboard_session';
const DUMMY_PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$J/HoUB66MRyhZllomniGFg$9+bKQE/IB0CGdy/KABJ62aIzOp05tULklvNtnMZpE/w';

function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function tokenHash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function cookieValue(req, name) {
  const item = String(req.get('Cookie') || '').split(';').map((value) => value.trim()).find((value) => value.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : '';
}

class AuthService {
  constructor({ identityStore, sessionTtlMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
    this.identityStore = identityStore;
    this.sessionTtlMs = sessionTtlMs;
    this.tokens = new Map();
    const configured = String(process.env.AUTH_TOKENS || '');
    for (const pair of configured.split(',').filter(Boolean)) {
      const split = pair.indexOf(':');
      if (split > 0) this.tokens.set(pair.slice(0, split), pair.slice(split + 1));
    }
    if (process.env.NODE_ENV !== 'production' && !this.tokens.size) this.tokens.set('local-dev-token', 'local-user');
    if (process.env.NODE_ENV === 'production' && !identityStore) throw new Error('DATABASE_URL is required for production authentication');
  }

  sessionCookieOptions() {
    return { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: this.sessionTtlMs };
  }

  async resolve(req) {
    const authorization = req.get('Authorization') || '';
    if (authorization.startsWith('Bearer ')) {
      const legacyId = this.tokens.get(authorization.slice(7));
      if (legacyId) {
        const identity = this.identityStore?.ensureLegacyIdentity
          ? await this.identityStore.ensureLegacyIdentity(legacyId)
          : { user: { id: legacyId, email: null, displayName: legacyId, status: 'active' }, tenant: { id: legacyId, name: legacyId, type: 'legacy' }, role: 'owner' };
        return { ...identity, authMethod: 'legacy' };
      }
    }
    const token = cookieValue(req, SESSION_COOKIE);
    if (!token || !this.identityStore) return null;
    const session = await this.identityStore.findSession(tokenHash(token));
    return session ? { ...session, authMethod: 'session', sessionToken: token } : null;
  }

  setRequestAuth(req, auth) {
    req.auth = { userId: auth.user.id, tenantId: auth.tenant.id, role: auth.role, platformRole: auth.user.platformRole || 'user', sessionId: auth.sessionId, method: auth.authMethod, legacyId: auth.legacyId };
    req.user = auth.user;
    req.tenant = auth.tenant;
  }

  middleware({ optional = false } = {}) {
    return async (req, res, next) => {
      try {
        const auth = await this.resolve(req);
        if (!auth) {
          if (optional) return next();
          return next(new AppError('UNAUTHENTICATED', 'Authentication is required', { status: 401 }));
        }
        this.setRequestAuth(req, auth);
        const origin = req.get('Origin');
        if (auth.authMethod === 'session' && origin && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
          const expected = `${req.protocol}://${req.get('host')}`;
          if (origin !== expected) return next(new AppError('CSRF_REJECTED', 'The request origin is not allowed', { status: 403 }));
        }
        next();
      } catch (error) { next(error); }
    };
  }

  async startSession(res, identity) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.sessionTtlMs);
    await this.identityStore.createSession({ tokenHash: tokenHash(token), userId: identity.user.id, tenantId: identity.tenant.id, expiresAt });
    res.cookie(SESSION_COOKIE, token, this.sessionCookieOptions());
    return { user: identity.user, tenant: identity.tenant, role: identity.role, expiresAt: expiresAt.toISOString() };
  }

  async register(input, res) {
    if (!this.identityStore) throw new AppError('AUTH_NOT_CONFIGURED', 'Account login requires an identity store', { status: 503 });
    const email = normalizeEmail(input.email);
    const displayName = String(input.displayName || '').trim();
    const password = String(input.password || '');
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 320) throw new AppError('VALIDATION_ERROR', 'Enter a valid email address', { status: 400 });
    if (displayName.length < 1 || displayName.length > 80) throw new AppError('VALIDATION_ERROR', 'Display name must be between 1 and 80 characters', { status: 400 });
    if (password.length > 1024) throw new AppError('VALIDATION_ERROR', 'Password must be between 12 and 1024 characters', { status: 400 });
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const identity = await this.identityStore.createUserWithPersonalWorkspace({ email, displayName, passwordHash });
    return this.startSession(res, identity);
  }

  async login(input, res) {
    if (!this.identityStore) throw new AppError('AUTH_NOT_CONFIGURED', 'Account login requires an identity store', { status: 503 });
    const email = normalizeEmail(input.email);
    const password = String(input.password || '');
    const identity = await this.identityStore.findUserByEmail(email);
    const passwordMatches = await argon2.verify(identity?.passwordHash || DUMMY_PASSWORD_HASH, password).catch(() => false);
    const valid = identity?.status === 'active' && passwordMatches;
    if (!valid) throw new AppError('INVALID_CREDENTIALS', 'Email or password is incorrect', { status: 401 });
    return this.startSession(res, { user: { id: identity.id, email: identity.email, displayName: identity.displayName, status: identity.status, platformRole: identity.platformRole || 'user' }, tenant: identity.tenant, role: identity.role });
  }

  async logout(req, res) {
    const token = cookieValue(req, SESSION_COOKIE);
    if (token && this.identityStore) await this.identityStore.deleteSession(tokenHash(token));
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/' });
  }


  async getMediaDefaults(userId) {
    return this.identityStore?.getMediaDefaults ? this.identityStore.getMediaDefaults(userId) : null;
  }

  async setMediaDefaults(userId, value) {
    if (!this.identityStore?.setMediaDefaults) throw new AppError('PREFERENCES_NOT_CONFIGURED', 'User preferences require an identity store', { status: 503 });
    return this.identityStore.setMediaDefaults(userId, value);
  }
}

module.exports = { AuthService, SESSION_COOKIE, normalizeEmail, tokenHash };
