const express = require('express');
const { asyncRoute } = require('./helpers');
const { validate } = require('../middleware/validate');
const {
  createScript, updateScript, scriptVisibility, publicScriptListQuery,
} = require('../schemas');

function createScriptsRouter({ scripts, projectStore }) {
  const router = express.Router();

  router.get('/', asyncRoute(async (req, res) => {
    res.json({ ok: true, scripts: await scripts.list({ tenantId: req.auth.tenantId }) });
  }));

  router.post('/', validate(createScript), asyncRoute(async (req, res) => {
    const script = await scripts.create({
      ...req.body,
      author: req.body.author || req.user?.displayName,
    }, { tenantId: req.auth.tenantId, userId: req.auth.userId });
    res.status(201).json({ ok: true, script });
  }));

  router.get('/:scriptId/stats', asyncRoute(async (req, res) => {
    res.json({
      ok: true,
      stats: await scripts.getOwnerStats(req.params.scriptId, { tenantId: req.auth.tenantId }),
    });
  }));

  router.get('/:scriptId', asyncRoute(async (req, res) => {
    res.json({ ok: true, script: await scripts.get(req.params.scriptId, { tenantId: req.auth.tenantId }) });
  }));

  router.put('/:scriptId', validate(updateScript), asyncRoute(async (req, res) => {
    res.json({
      ok: true,
      script: await scripts.update(req.params.scriptId, req.body, { tenantId: req.auth.tenantId }),
    });
  }));

  router.post('/:scriptId/visibility', validate(scriptVisibility), asyncRoute(async (req, res) => {
    res.json({
      ok: true,
      script: await scripts.setVisibility(req.params.scriptId, req.body.visibility, { tenantId: req.auth.tenantId }),
    });
  }));

  router.post('/:scriptId/like', asyncRoute(async (req, res) => {
    res.json({
      ok: true,
      ...(await scripts.toggleLike(req.params.scriptId, { userId: req.auth.userId })),
    });
  }));

  router.get('/:scriptId/projects', asyncRoute(async (req, res) => {
    res.json({
      ok: true,
      projects: await scripts.listProjects(req.params.scriptId, {
        tenantId: req.auth.tenantId,
        projectStore,
      }),
    });
  }));

  return router;
}

function createPublicScriptsRouter({ scripts, optionalAuth }) {
  const router = express.Router();
  if (optionalAuth) router.use(optionalAuth);

  router.get('/', validate(publicScriptListQuery, 'query'), asyncRoute(async (req, res) => {
    res.json({
      ok: true,
      scripts: await scripts.listPublic({
        limit: req.query.limit,
        offset: req.query.offset,
      }),
    });
  }));

  router.get('/categories', asyncRoute(async (req, res) => {
    res.json({ ok: true, categories: await scripts.listCategories() });
  }));

  router.get('/category/:slug', validate(publicScriptListQuery, 'query'), asyncRoute(async (req, res) => {
    res.json({
      ok: true,
      scripts: await scripts.listPublicByCategory(req.params.slug, {
        limit: req.query.limit,
        offset: req.query.offset,
      }),
    });
  }));

  router.get('/tag/:slug', validate(publicScriptListQuery, 'query'), asyncRoute(async (req, res) => {
    res.json({
      ok: true,
      scripts: await scripts.listPublicByTag(req.params.slug, {
        limit: req.query.limit,
        offset: req.query.offset,
      }),
    });
  }));

  router.get('/:slug', asyncRoute(async (req, res) => {
    res.json({
      ok: true,
      script: await scripts.getPublicBySlug(req.params.slug, { userId: req.auth?.userId }),
    });
  }));

  return router;
}

module.exports = { createScriptsRouter, createPublicScriptsRouter };
