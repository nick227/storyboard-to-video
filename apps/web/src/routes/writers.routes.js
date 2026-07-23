const express = require('express');
const { asyncRoute } = require('./helpers');
const { validate } = require('../middleware/validate');
const { updateWriterProfile } = require('../schemas');

function createPublicWritersRouter({ writers, optionalAuth }) {
  const router = express.Router();
  if (optionalAuth) router.use(optionalAuth);

  router.get('/:profileSlug', asyncRoute(async (req, res) => {
    res.json({
      ok: true,
      writer: await writers.getPublicProfile(req.params.profileSlug, { viewerUserId: req.auth?.userId }),
    });
  }));

  return router;
}

function createWritersRouter({ writers }) {
  const router = express.Router();

  router.get('/me', asyncRoute(async (req, res) => {
    res.json({ ok: true, writer: await writers.getMe({ userId: req.auth.userId }) });
  }));

  router.put('/me', validate(updateWriterProfile), asyncRoute(async (req, res) => {
    res.json({
      ok: true,
      writer: await writers.updateProfile({ userId: req.auth.userId }, req.body),
    });
  }));

  router.post('/:userId/follow', asyncRoute(async (req, res) => {
    res.json({
      ok: true,
      ...(await writers.toggleFollow(req.params.userId, { followerUserId: req.auth.userId })),
    });
  }));

  return router;
}

module.exports = { createPublicWritersRouter, createWritersRouter };
