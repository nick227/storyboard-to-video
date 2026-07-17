const express = require('express');
const { asyncRoute } = require('./helpers');

function authRoutes(auth) {
  const router = express.Router();
  router.post('/register', asyncRoute(async (req, res) => res.status(201).json({ ok: true, session: await auth.register(req.body || {}, res) })));
  router.post('/login', asyncRoute(async (req, res) => res.json({ ok: true, session: await auth.login(req.body || {}, res) })));
  router.get('/session', auth.middleware({ optional: true }), (req, res) => res.json({ ok: true, authenticated: Boolean(req.auth), session: req.auth ? { user: req.user, tenant: req.tenant, role: req.auth.role } : null }));
  router.post('/logout', auth.middleware({ optional: true }), asyncRoute(async (req, res) => { await auth.logout(req, res); res.json({ ok: true }); }));
  return router;
}

module.exports = { authRoutes };
