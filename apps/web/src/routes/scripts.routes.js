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

function createPublicScriptsRouter({ scripts }) {
  const router = express.Router();

  router.get('/', validate(publicScriptListQuery, 'query'), asyncRoute(async (req, res) => {
    res.json({
      ok: true,
      scripts: await scripts.listPublic({
        limit: req.query.limit,
        offset: req.query.offset,
      }),
    });
  }));

  router.get('/:slug', asyncRoute(async (req, res) => {
    res.json({ ok: true, script: await scripts.getPublicBySlug(req.params.slug) });
  }));

  return router;
}

module.exports = { createScriptsRouter, createPublicScriptsRouter };
