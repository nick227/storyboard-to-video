// Establishes a usage-tracking trace for project-independent operations (voice preflight,
// clone, reference-audio fetch) that don't go through the job-queue-based execute() middleware
// (which requires an existing, owned project -- wrong shape for these). Without this, calls to
// usageTracker.execute() inside voice.service.js silently no-op (no GenerationRequest/UsageEvent
// ever created) rather than failing, because generationContext.getStore() returns undefined.
function createGenerationTraceMiddleware(generationContext) {
  return (req, res, next) => {
    generationContext.run({
      providerSequence: 0,
      trace: {
        tenantId: req.auth.tenantId,
        userId: req.auth.userId,
        projectId: null,
        sceneId: null,
        jobId: null,
        idempotencyKey: req.idempotencyKey || null,
      },
    }, next);
  };
}

module.exports = { createGenerationTraceMiddleware };
