const express = require('express');
const { asyncRoute } = require('./helpers');

function customStylesRoutes({ controller, upload, generationTrace }) {
  const router = express.Router();
  router.get('/', asyncRoute(controller.customList));
  router.post('/', asyncRoute(controller.customCreate));
  router.patch('/:styleId', asyncRoute(controller.customUpdate));
  router.delete('/:styleId', asyncRoute(controller.customArchive));
  router.get('/:styleId/references', asyncRoute(controller.customReferences));
  router.post('/:styleId/references', upload.array('files', 4), asyncRoute(controller.customReferenceUpload));
  router.post('/:styleId/references/generate', generationTrace, asyncRoute(controller.customReferenceGenerate));
  router.patch('/:styleId/references/order', asyncRoute(controller.customReferenceOrder));
  router.delete('/:styleId/references/:referenceId', asyncRoute(controller.customReferenceRemove));
  router.get('/:styleId/references/:referenceId/content', asyncRoute(controller.customReferenceContent));
  return router;
}

module.exports = { customStylesRoutes };
