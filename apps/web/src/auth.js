const { AppError } = require('./errors');

class AuthService {
  constructor() {
    this.tokens = new Map();
    const configured = String(process.env.AUTH_TOKENS || '');
    for (const pair of configured.split(',').filter(Boolean)) {
      const split = pair.indexOf(':');
      if (split > 0) this.tokens.set(pair.slice(0, split), pair.slice(split + 1));
    }
    if (process.env.NODE_ENV !== 'production' && !this.tokens.size) this.tokens.set('local-dev-token', 'local-user');
    if (process.env.NODE_ENV === 'production' && !this.tokens.size) throw new Error('AUTH_TOKENS is required in production');
  }

  tokenFrom(req) {
    const authorization = req.get('Authorization') || '';
    if (authorization.startsWith('Bearer ')) return authorization.slice(7);
    const cookie = String(req.get('Cookie') || '').split(';').map((x) => x.trim()).find((x) => x.startsWith('storyboard_token='));
    return cookie ? decodeURIComponent(cookie.slice('storyboard_token='.length)) : '';
  }

  middleware() {
    return (req, res, next) => {
      const token = this.tokenFrom(req);
      const ownerId = this.tokens.get(token);
      if (!ownerId) return next(new AppError('UNAUTHENTICATED', 'Authentication is required', { status: 401 }));
      req.user = { id: ownerId };
      if (req.get('Authorization')) res.cookie('storyboard_token', token, { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/' });
      next();
    };
  }
}

module.exports = { AuthService };
