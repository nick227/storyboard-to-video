const express = require('express');
const { createProject, projectDocument } = require('../schemas');
const { validate } = require('../middleware/validate');
const { AppError } = require('../errors');

function createProjectRouter({ store, queue }) {
  const router = express.Router();

  router.get('/', (req, res) => res.json({ ok: true, projects: store.list({ ownerId: req.auth.tenantId }) }));
  router.post('/', validate(createProject), (req, res) => res.status(201).json({ ok: true, project: store.create(req.body, { tenantId: req.auth.tenantId, createdByUserId: req.auth.userId }) }));
  router.post('/:projectId/cleanup', (req, res) => res.json({ ok: true, removed: store.cleanup(req.params.projectId, { ownerId: req.auth.tenantId }) }));
  router.delete('/:projectId/assets/:type/:fileName', (req, res) => {
    store.deleteAsset(req.params.projectId, req.params.type, req.params.fileName, { ownerId: req.auth.tenantId });
    res.status(204).end();
  });
  router.get('/:projectId', (req, res) => res.json({ ok: true, project: store.read(req.params.projectId, { ownerId: req.auth.tenantId }) }));
  router.put('/:projectId', validate(projectDocument), (req, res) => {
    const header = req.get('If-Match');
    const expectedRevision = header ? Number(String(header).replace(/^W\/|"/g, '').replace(/"$/, '')) : req.body.revision;
    if (!Number.isInteger(expectedRevision)) throw new AppError('REVISION_REQUIRED', 'If-Match or a numeric revision is required', { status: 428 });
    const project = store.write(req.params.projectId, req.body, { expectedRevision, ownerId: req.auth.tenantId });
    res.set('ETag', `"${project.revision}"`).json({ ok: true, project });
  });
  router.delete('/:projectId', (req, res) => {
    store.read(req.params.projectId, { ownerId: req.auth.tenantId });
    queue.cancelProject(req.params.projectId);
    store.delete(req.params.projectId, { ownerId: req.auth.tenantId });
    res.status(204).end();
  });

  return router;
}

module.exports = { createProjectRouter };
