const express = require('express');
const { asyncRoute } = require('./helpers');
const { isPlatformAdmin } = require('../middleware/style-admin');
const { mediaSettings } = require('../schemas');

function authRoutes(auth) {
  const router = express.Router();
  router.post('/register', asyncRoute(async (req, res) => res.status(201).json({ ok: true, session: await auth.register(req.body || {}, res) })));
  router.post('/login', asyncRoute(async (req, res) => res.json({ ok: true, session: await auth.login(req.body || {}, res) })));
  router.get('/session', auth.middleware({ optional: true }), (req, res) => res.json({
    ok: true,
    authenticated: Boolean(req.auth),
    session: req.auth ? {
      user: req.user,
      tenant: req.tenant,
      role: req.auth.role,
      isPlatformAdmin: isPlatformAdmin(req),
    } : null,
  }));
  router.post('/logout', auth.middleware({ optional: true }), asyncRoute(async (req, res) => { await auth.logout(req, res); res.json({ ok: true }); }));
  router.get('/preferences/media', auth.middleware(), asyncRoute(async (req, res) => res.json({ ok: true, mediaDefaults: await auth.getMediaDefaults(req.auth.userId) })));
  router.put('/preferences/media', auth.middleware(), asyncRoute(async (req, res) => {
    const parsed = mediaSettings.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message || 'Invalid media defaults' } });
    res.json({ ok: true, mediaDefaults: await auth.setMediaDefaults(req.auth.userId, parsed.data) });
  }));
  return router;
}

module.exports = { authRoutes };
