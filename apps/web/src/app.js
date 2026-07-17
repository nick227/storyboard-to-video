const express = require('express');
const multer = require('multer');
const { requestId } = require('./middleware/request-id');
const { errorMiddleware, notFound, AppError } = require('./errors');
const { createProjectRouter } = require('./routes/projects');
const { createJobRouter } = require('./routes/jobs');
const { storyboardRoutes } = require('./routes/storyboard.routes');
const { imagesRoutes } = require('./routes/images.routes');
const { audioRoutes } = require('./routes/audio.routes');
const { videosRoutes } = require('./routes/videos.routes');
const { stylesRoutes } = require('./routes/styles.routes');
const { exportsRoutes } = require('./routes/exports.routes');
const { assetsRoutes } = require('./routes/assets.routes');
const { authRoutes } = require('./routes/auth.routes');
const { usageRoutes } = require('./routes/usage.routes');
const { billingRoutes } = require('./routes/billing.routes');

function createApp(dependencies) {
  const app = express();
  registerMiddleware(app, dependencies);
  app.use('/api/auth', authRoutes(dependencies.auth));
  app.use(['/api', '/projects', '/style-references'], dependencies.authenticate);
  registerRoutes(app, dependencies);
  registerErrorHandler(app);
  return app;
}

function registerMiddleware(app, { config, auth }) {
  app.use(express.json({ limit: config.limits.json }));
  app.use(requestId);
  app.use(pageGuard(auth));
  app.use(express.static(config.paths.public));
}

// Server-rendered guard for the two HTML entry points, so an unauthenticated
// visitor never receives the storyboard shell (no client-side flash to hide).
function pageGuard(auth) {
  const GUARDED_APP_PATHS = new Set(['/', '/index.html']);
  const LOGIN_PATH = '/login.html';
  const safeRedirectTarget = (value) => (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/');

  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const isAppPage = GUARDED_APP_PATHS.has(req.path);
    const isLoginPage = req.path === LOGIN_PATH;
    if (!isAppPage && !isLoginPage) return next();

    let identity = null;
    try { identity = await auth.resolve(req); } catch { identity = null; }

    if (isLoginPage) {
      if (identity) return res.redirect(safeRedirectTarget(req.query.redirect));
      return next();
    }
    if (identity) return next();
    return res.redirect(`${LOGIN_PATH}?redirect=${encodeURIComponent(req.originalUrl || '/')}`);
  };
}

function registerRoutes(app, d) {
  app.use(assetsRoutes(d.controllers.assets));
  app.use('/api/projects', createProjectRouter({ store: d.projectStore, queue: d.queue }));
  app.use('/api/jobs', createJobRouter({ queue: d.queue, store: d.projectStore }));
  app.use('/api/admin/usage', usageRoutes(d.usageRepository));
  app.use('/api/admin/billing', billingRoutes(d.billingRepository, d.billing));
  app.use('/api/styles', stylesRoutes({ controller: d.controllers.styles, upload: d.upload }));
  app.use('/api/storyboard', storyboardRoutes({ controller: d.controllers.storyboard, idempotency: d.idempotency, execute: d.execute }));
  app.use('/api/images', imagesRoutes({ controller: d.controllers.media, idempotency: d.idempotency, execute: d.execute }));
  app.use('/api/videos', videosRoutes({ controller: d.controllers.media, idempotency: d.idempotency, execute: d.execute }));
  app.use('/api/audio', audioRoutes({ controller: d.controllers.media, voices: d.controllers.voices, upload: d.upload, idempotency: d.idempotency, execute: d.execute }));
  app.use('/api/images/zip', exportsRoutes(d.controllers.media));
  app.use(notFound);
}

function registerErrorHandler(app) {
  app.use((error, req, res, next) => {
    const normalized = error instanceof multer.MulterError
      ? new AppError('UPLOAD_ERROR', error.code === 'LIMIT_FILE_SIZE' ? 'Reference images must be 8 MB or smaller.' : error.message, { status: 400 })
      : error;
    return errorMiddleware(normalized, req, res, next);
  });
}

module.exports = { createApp, registerErrorHandler, registerMiddleware, registerRoutes };
