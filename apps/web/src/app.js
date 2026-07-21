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
const { subtitlesRoutes } = require('./routes/subtitles.routes');
const { stylesRoutes } = require('./routes/styles.routes');
const { exportsRoutes } = require('./routes/exports.routes');
const { assetsRoutes } = require('./routes/assets.routes');
const { authRoutes } = require('./routes/auth.routes');
const { usageRoutes } = require('./routes/usage.routes');
const { billingRoutes } = require('./routes/billing.routes');
const { adminRoutes } = require('./routes/admin.routes');
const { paymentRoutes, stripeWebhookHandler } = require('./routes/payment.routes');
const { mediaOutputRoutes } = require('./routes/media-output.routes');
const { isPlatformAdmin } = require('./middleware/style-admin');

function createApp(dependencies) {
  const app = express();
  registerMiddleware(app, dependencies);
  app.use('/api/auth', authRoutes(dependencies.auth));
  app.use(['/api', '/projects', '/style-references', '/user-style-references'], dependencies.authenticate);
  registerRoutes(app, dependencies);
  registerErrorHandler(app);
  return app;
}

function registerMiddleware(app, { config, auth, payments }) {
  app.post('/api/webhooks/stripe', express.raw({ type: 'application/json', limit: '2mb' }), stripeWebhookHandler(payments));
  app.use(express.json({ limit: config.limits.json }));
  app.use(requestId);
  app.use(pageGuard(auth));
  app.get('/favicon.ico', (req, res) => res.redirect('/images/favicon.png'));
  app.use(express.static(config.paths.public, { extensions: ['html'] }));
}

// Server-rendered guard for the authenticated HTML entry points, so an unauthenticated
// visitor never receives the storyboard shell (no client-side flash to hide).
function pageGuard(auth) {
  const GUARDED_APP_PATHS = new Set(['/studio', '/studio.html']);
  const ADMIN_PATHS = new Set(['/admin', '/admin.html']);
  const CUSTOMER_PATHS = new Set(['/credits', '/credits.html']);
  const TOOL_PATHS = new Set(['/text-to-speech', '/text-to-speech.html']);
  const LOGIN_PATH = '/login.html';
  const safeRedirectTarget = (value) => (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/');

  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const isAppPage = GUARDED_APP_PATHS.has(req.path);
    const isAdminPage = ADMIN_PATHS.has(req.path);
    const isCustomerPage = CUSTOMER_PATHS.has(req.path);
    const isToolPage = TOOL_PATHS.has(req.path);
    const isLoginPage = req.path === LOGIN_PATH;
    if (!isAppPage && !isLoginPage && !isAdminPage && !isCustomerPage && !isToolPage) return next();

    let identity = null;
    try { identity = await auth.resolve(req); } catch { identity = null; }

    if (isLoginPage) {
      if (identity) return res.redirect(safeRedirectTarget(req.query.redirect));
      return next();
    }
    if (isAdminPage) {
      if (!identity) return res.redirect(`${LOGIN_PATH}?redirect=${encodeURIComponent(req.originalUrl || '/admin.html')}`);
      const adminRequest = { auth: { userId: identity.user.id, platformRole: identity.user.platformRole, legacyId: identity.legacyId }, user: identity.user };
      if (!isPlatformAdmin(adminRequest)) return res.status(403).send('Platform administration is not permitted.');
      if (req.path === '/admin.html') return res.redirect('/admin');
      return next();
    }
    if (isCustomerPage) {
      if (!identity) return res.redirect(`${LOGIN_PATH}?redirect=${encodeURIComponent(req.originalUrl || '/credits.html')}`);
      if (req.path === '/credits.html') return res.redirect('/credits');
      return next();
    }
    if (isToolPage) {
      if (!identity) return res.redirect(`${LOGIN_PATH}?redirect=${encodeURIComponent(req.originalUrl || '/text-to-speech.html')}`);
      if (req.path === '/text-to-speech.html') return res.redirect('/text-to-speech');
      return next();
    }
    if (identity) {
      if (req.path === '/studio.html') return res.redirect('/studio');
      return next();
    }
    const target = req.path === '/studio.html' ? '/studio' : (req.originalUrl || '/studio');
    return res.redirect(`${LOGIN_PATH}?redirect=${encodeURIComponent(target)}`);
  };
}

function registerRoutes(app, d) {
  app.use(assetsRoutes(d.controllers.assets));
  app.use('/api/projects', createProjectRouter({
    store: d.projectStore, queue: d.queue, upload: d.upload, shotReferences: d.shotReferences,
    styles: d.styles, prompts: d.prompts, referenceGeneration: d.referenceGeneration, imageProvider: d.imageProvider, identityStore: d.identityStore, prisma: d.prisma, config: d.config
  }));
  app.use('/api/jobs', createJobRouter({ queue: d.queue, store: d.projectStore, videoAttempts: d.videoAttemptRepository, videoExecution: d.videoExecution }));
  app.use('/api/admin/usage', usageRoutes(d.usageRepository));
  app.use('/api/admin/billing', billingRoutes(d.billingRepository, d.billing, d.adminRepository));
  app.use('/api/admin', adminRoutes(d.adminRepository, d.queue, d.paymentRepository, d.payments));
  app.use('/api/billing', paymentRoutes(d.paymentRepository, d.payments));
  app.use('/api/media-output', mediaOutputRoutes(d.mediaOutput));
  app.use('/api/styles', stylesRoutes({ controller: d.controllers.styles, upload: d.upload }));
  app.use('/api/storyboard', storyboardRoutes({ controller: d.controllers.storyboard, idempotency: d.idempotency, execute: d.execute }));
  app.use('/api/images', imagesRoutes({ controller: d.controllers.media, idempotency: d.idempotency, execute: d.execute }));
  app.use('/api/videos', videosRoutes({ controller: d.controllers.media, idempotency: d.idempotency, execute: d.execute }));
  app.use('/api/audio', audioRoutes({ controller: d.controllers.media, voices: d.controllers.voices, upload: d.upload, idempotency: d.idempotency, execute: d.execute }));
  app.use('/api/subtitles', subtitlesRoutes({ controller: d.controllers.media, idempotency: d.idempotency, execute: d.execute }));
  app.use('/api/images/zip', exportsRoutes(d.controllers.media));
  app.use(notFound);
}

function registerErrorHandler(app) {
  app.use((error, req, res, next) => {
    const normalized = error instanceof multer.MulterError
      ? new AppError('UPLOAD_ERROR', error.code === 'LIMIT_FILE_SIZE' ? 'Reference images must be 8 MB or smaller.' : error.message, { status: 400 })
      : error;
    // Read by jobs/execution.js's `finish` handler: res.statusCode alone tells it the request
    // failed, but not why — stashing the real error here (before the response goes out) lets job
    // history/the stage-bar failed counts/the per-scene status-icon failed state show the actual
    // failure reason instead of a generic "Request failed with status 500".
    req.generationError = normalized;
    return errorMiddleware(normalized, req, res, next);
  });
}

module.exports = { createApp, registerErrorHandler, registerMiddleware, registerRoutes };
