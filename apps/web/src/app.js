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

function createApp(dependencies) {
  const app = express();
  registerMiddleware(app, dependencies);
  app.use('/api/auth', authRoutes(dependencies.auth));
  app.use(['/api', '/projects', '/style-references'], dependencies.authenticate);
  registerRoutes(app, dependencies);
  registerErrorHandler(app);
  return app;
}

function registerMiddleware(app, { config }) {
  app.use(express.json({ limit: config.limits.json }));
  app.use(requestId);
  app.use(express.static(config.paths.public));
}

function registerRoutes(app, d) {
  app.use(assetsRoutes(d.controllers.assets));
  app.use('/api/projects', createProjectRouter({ store: d.projectStore, queue: d.queue }));
  app.use('/api/jobs', createJobRouter({ queue: d.queue, store: d.projectStore }));
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
