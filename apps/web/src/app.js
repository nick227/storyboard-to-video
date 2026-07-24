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
const { customStylesRoutes } = require('./routes/custom-styles.routes');
const { exportsRoutes } = require('./routes/exports.routes');
const { assetsRoutes } = require('./routes/assets.routes');
const { asyncRoute } = require('./routes/helpers');
const { authRoutes } = require('./routes/auth.routes');
const { usageRoutes } = require('./routes/usage.routes');
const { billingRoutes } = require('./routes/billing.routes');
const { adminRoutes } = require('./routes/admin.routes');
const { paymentRoutes, stripeWebhookHandler } = require('./routes/payment.routes');
const { mediaOutputRoutes } = require('./routes/media-output.routes');
const { createScriptsRouter, createPublicScriptsRouter } = require('./routes/scripts.routes');
const { createWritersRouter, createPublicWritersRouter } = require('./routes/writers.routes');
const { isPlatformAdmin } = require('./middleware/style-admin');
const {
  isEditPath, workPath, libraryHomePath, libraryCategoryPath, libraryTagPath,
  legacyStudioRedirect, ARTIFACTS,
} = require('./shared/app-paths');
const fs = require('node:fs');
const path = require('node:path');

const ARTIFACT_PARAM = ARTIFACTS.join('|');

function createApp(dependencies) {
  const app = express();
  // Railway (and most PaaS) terminate TLS at the edge. Without this, req.protocol is "http" while
  // the browser Origin is "https://...", so session CSRF checks reject every authenticated POST.
  app.set('trust proxy', 1);
  registerMiddleware(app, dependencies);
  app.use('/api/auth', authRoutes(dependencies.auth));
  app.use('/api/public/scripts', createPublicScriptsRouter({
    scripts: dependencies.scripts,
    optionalAuth: dependencies.auth.middleware({ optional: true }),
  }));
  app.use('/api/public/writers', createPublicWritersRouter({
    writers: dependencies.writers,
    optionalAuth: dependencies.auth.middleware({ optional: true }),
  }));
  // Public storyboard/timeline viewers need unauthenticated media when the artifact is published.
  app.get(
    '/projects/:projectId/assets/:type/:fileName',
    dependencies.auth.middleware({ optional: true }),
    asyncRoute((req, res) => dependencies.controllers.assets.project(req, res)),
  );
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
  registerPageRoutes(app, config);
  app.get('/favicon.ico', (req, res) => res.redirect('/images/favicon.png'));
  app.use(express.static(config.paths.public, { index: false }));
}

function createSendPage(pagesDir) {
  const topbarPartial = path.join(pagesDir, 'partials', 'topbar.html');
  const workbarPartial = path.join(pagesDir, 'partials', 'workbar.html');
  return (filename) => (req, res) => {
    const filePath = path.isAbsolute(filename) ? filename : path.join(pagesDir, filename);
    const topbar = fs.readFileSync(topbarPartial, 'utf8').trim();
    const workbar = fs.readFileSync(workbarPartial, 'utf8').trim();
    const html = fs.readFileSync(filePath, 'utf8')
      .replaceAll('<!--topbar-->', topbar)
      .replaceAll('<!--workbar-->', workbar);
    res.type('html').send(html);
  };
}

function registerPageRoutes(app, config) {
  const sendPage = createSendPage(config.paths.pages);
  const pages = [
    [['/', '/index.html'], 'index.html'],
    [['/login', '/login.html'], 'login.html'],
    [['/admin', '/admin.html'], 'admin.html'],
    [['/credits', '/credits.html'], 'credits.html'],
    [['/text-to-speech', '/text-to-speech.html'], 'text-to-speech.html'],
    [['/library'], 'scripts.html'],
    [['/scripts-browse.html'], 'scripts-browse.html'],
    [['/script-reader.html'], 'script-reader.html'],
    [['/writer.html'], 'writer.html'],
  ];
  for (const [routes, filename] of pages) app.get(routes, sendPage(filename));

  app.get(['/scripts', '/scripts.html'], (req, res) => res.redirect(301, libraryHomePath()));

  // Artifact editor: /{author}/{slug}/{artifact}/edit
  app.get(`/:author/:slug/:artifact(${ARTIFACT_PARAM})/edit`, (req, res, next) => {
    if (req.params.author.includes('.') || req.params.slug.includes('.')) return next();
    return sendPage('studio.html')(req, res);
  });

  // Public artifact: screenplay reader; storyboard/timeline read-only viewers (no cover)
  app.get(`/:author/:slug/:artifact(${ARTIFACT_PARAM})`, (req, res, next) => {
    if (req.params.author.includes('.') || req.params.slug.includes('.')) return next();
    return sendPage('script-reader.html')(req, res);
  });

  // Legacy studio surfaces → library (entity-less) or resolved edit URL
  app.get(['/script', '/storyboard', '/timeline'], (req, res) => res.redirect(301, libraryHomePath()));
  app.get(['/script/:slug', '/storyboard/:slug', '/timeline/:slug'], (req, res, next) => {
    if (req.params.slug.includes('.')) return next();
    const artifact = req.path.startsWith('/script') ? 'screenplay'
      : req.path.startsWith('/timeline') ? 'timeline' : 'storyboard';
    return res.redirect(302, workPath('anonymous', req.params.slug, artifact, { edit: true }));
  });
  app.get(['/studio', '/studio.html'], (req, res) => res.redirect(301, legacyStudioRedirect(req)));

  if (config.env?.NODE_ENV !== 'production') {
    app.get(['/test', '/test.html'], sendPage(path.join('dev', 'test.html')));
    app.get('/dev/screenplay-editor', sendPage(path.join('dev', 'screenplay-editor.html')));
  }
}

// Server-rendered guard for the authenticated HTML entry points, so an unauthenticated
// visitor never receives the storyboard shell (no client-side flash to hide).
function pageGuard(auth) {
  const ADMIN_PATHS = new Set(['/admin', '/admin.html']);
  const CUSTOMER_PATHS = new Set(['/credits', '/credits.html']);
  const TOOL_PATHS = new Set(['/text-to-speech', '/text-to-speech.html']);
  const LOGIN_PATHS = new Set(['/login', '/login.html']);
  const LOGIN_PATH = '/login.html';
  const safeRedirectTarget = (value) => (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/');

  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const isAppPage = isEditPath(req.path);
    const isAdminPage = ADMIN_PATHS.has(req.path);
    const isCustomerPage = CUSTOMER_PATHS.has(req.path);
    const isToolPage = TOOL_PATHS.has(req.path);
    const isLoginPage = LOGIN_PATHS.has(req.path);
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
    if (identity) return next();
    return res.redirect(`${LOGIN_PATH}?redirect=${encodeURIComponent(req.originalUrl || libraryHomePath())}`);
  };
}

function registerRoutes(app, d) {
  const sendPage = createSendPage(d.config.paths.pages);
  app.get('/writers/:slug', (req, res, next) => {
    if (req.params.slug.includes('.')) return next();
    return sendPage('writer.html')(req, res);
  });
  app.get('/library/category/:slug', (req, res, next) => {
    if (req.params.slug.includes('.')) return next();
    return sendPage('scripts-browse.html')(req, res);
  });
  app.get('/library/tag/:slug', (req, res, next) => {
    if (req.params.slug.includes('.')) return next();
    return sendPage('scripts-browse.html')(req, res);
  });

  // Legacy /library/:author/:script → /:author/:script/screenplay
  app.get('/library/:author/:script', (req, res, next) => {
    if (req.params.author.includes('.') || req.params.script.includes('.')) return next();
    return res.redirect(301, workPath(req.params.author, req.params.script, 'screenplay'));
  });

  app.get('/scripts/category/:slug', (req, res, next) => {
    if (req.params.slug.includes('.')) return next();
    return res.redirect(301, libraryCategoryPath(req.params.slug));
  });
  app.get('/scripts/tag/:slug', (req, res, next) => {
    if (req.params.slug.includes('.')) return next();
    return res.redirect(301, libraryTagPath(req.params.slug));
  });
  app.get('/scripts/:slug', async (req, res, next) => {
    if (req.params.slug.includes('.')) return next();
    try {
      return res.redirect(301, await d.scripts.resolveSharePath(req.params.slug));
    } catch (_) {
      return res.redirect(302, libraryHomePath());
    }
  });
  app.use(assetsRoutes(d.controllers.assets));
  app.use('/api/projects', createProjectRouter({
    store: d.projectStore, queue: d.queue, upload: d.upload, shotReferences: d.shotReferences,
    styles: d.styles, prompts: d.prompts, referenceGeneration: d.referenceGeneration, imageProvider: d.imageProvider, identityStore: d.identityStore, prisma: d.prisma, config: d.config, spendSummary: d.spendSummary, scripts: d.scripts,
  }));
  app.use('/api/scripts', createScriptsRouter({ scripts: d.scripts, projectStore: d.projectStore }));
  app.use('/api/writers', createWritersRouter({ writers: d.writers }));
  app.use('/api/jobs', createJobRouter({ queue: d.queue, store: d.projectStore, videoAttempts: d.videoAttemptRepository, videoExecution: d.videoExecution }));
  app.use('/api/admin/usage', usageRoutes(d.usageRepository));
  app.use('/api/admin/billing', billingRoutes(d.billingRepository, d.billing, d.adminRepository, d.spendSummary, d.payments));
  app.use('/api/admin', adminRoutes(d.adminRepository, d.queue, d.paymentRepository, d.payments));
  app.use('/api/billing', paymentRoutes(d.paymentRepository, d.payments, d.spendSummary));
  app.use('/api/media-output', mediaOutputRoutes(d.mediaOutput));
  app.use('/api/styles', stylesRoutes({ controller: d.controllers.styles, upload: d.upload }));
  app.use('/api/custom-styles', customStylesRoutes({ controller: d.controllers.styles, upload: d.upload, generationTrace: d.generationTrace }));
  app.use('/api/storyboard', storyboardRoutes({ controller: d.controllers.storyboard, idempotency: d.idempotency, execute: d.execute }));
  app.use('/api/images', imagesRoutes({ controller: d.controllers.media, idempotency: d.idempotency, execute: d.execute }));
  app.use('/api/videos', videosRoutes({ controller: d.controllers.media, idempotency: d.idempotency, execute: d.execute }));
  app.use('/api/audio', audioRoutes({ controller: d.controllers.media, voices: d.controllers.voices, upload: d.upload, idempotency: d.idempotency, execute: d.execute, generationTrace: d.generationTrace }));
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
