const express = require('express');
const { createProject, projectDocument } = require('../schemas');
const { validate } = require('../middleware/validate');
const { AppError } = require('../errors');

function createProjectRouter({ store, queue }) {
  const router = express.Router();
  const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

  router.get('/', asyncRoute(async (req, res) => res.json({ ok: true, projects: await store.list({ ownerId: req.auth.tenantId }) })));
  router.post('/', validate(createProject), asyncRoute(async (req, res) => res.status(201).json({ ok: true, project: await store.create(req.body, { tenantId: req.auth.tenantId, createdByUserId: req.auth.userId }) })));
  router.post('/:projectId/cleanup', asyncRoute(async (req, res) => res.json({ ok: true, removed: await store.cleanup(req.params.projectId, { ownerId: req.auth.tenantId }) })));
  router.delete('/:projectId/assets/:type/:fileName', asyncRoute(async (req, res) => {
    await store.deleteAsset(req.params.projectId, req.params.type, req.params.fileName, { ownerId: req.auth.tenantId });
    res.status(204).end();
  }));
  router.get('/:projectId', asyncRoute(async (req, res) => res.json({ ok: true, project: await store.read(req.params.projectId, { ownerId: req.auth.tenantId }) })));
  router.put('/:projectId', validate(projectDocument), asyncRoute(async (req, res) => {
    const header = req.get('If-Match');
    const expectedRevision = header ? Number(String(header).replace(/^W\/|"/g, '').replace(/"$/, '')) : req.body.revision;
    if (!Number.isInteger(expectedRevision)) throw new AppError('REVISION_REQUIRED', 'If-Match or a numeric revision is required', { status: 428 });
    const project = await store.write(req.params.projectId, req.body, { expectedRevision, ownerId: req.auth.tenantId });
    res.set('ETag', `"${project.revision}"`).json({ ok: true, project });
  }));
  router.delete('/:projectId', asyncRoute(async (req, res) => {
    await store.read(req.params.projectId, { ownerId: req.auth.tenantId });
    await queue.cancelProject(req.params.projectId);
    await store.delete(req.params.projectId, { ownerId: req.auth.tenantId });
    res.status(204).end();
  }));

  return router;
}

module.exports = { createProjectRouter };
