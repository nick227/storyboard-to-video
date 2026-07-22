// Establishes a usage-tracking trace for project-independent operations (voice preflight,
// clone, reference-audio fetch) that don't go through the job-queue-based execute() middleware
// (which requires an existing, owned project -- wrong shape for these). Without this, calls to
// usageTracker.execute() inside voice.service.js silently no-op (no GenerationRequest/UsageEvent
// ever created) rather than failing, because generationContext.getStore() returns undefined.
function createGenerationTraceMiddleware(generationContext) {
  return (req, res, next) => {
    // A real AbortSignal, not just omitted: dependencies.js's cancellation() reads
    // generationContext.getStore()?.signal and falls back to the *whole store object* when it's
    // missing -- providers/http.js's signal() then passes that fake, non-AbortSignal value into
    // AbortSignal.any([...]), which throws ("signal.addEventListener is not a function") the
    // moment any provider call in this trace tries to build its request signal. There's no
    // job-cancellation UX for these requests, so this AbortController is never triggered -- it
    // exists purely so the shape matches what createJobExecution's real job signal provides.
    const { signal } = new AbortController();
    generationContext.run({
      signal,
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
