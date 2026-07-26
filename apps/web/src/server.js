function probeImageService(config) {
  const url = config.imageServiceUrl;
  if (!url) {
    console.log('Modal SDXL: IMAGE_SERVICE_URL unset (sdxl provider disabled)');
    return;
  }
  const started = Date.now();
  fetch(`${url}/health`, { signal: AbortSignal.timeout(120_000) })
    .then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      console.log(`Modal SDXL: health ok (${Date.now() - started}ms) ${url} model=${body.model || '?'} cuda=${body.cuda}`);
    })
    .catch((error) => {
      console.warn(`Modal SDXL: health FAILED for ${url}: ${error.message || error}`);
    });
}

function startServer(app, config) {
  return app.listen(config.port, () => {
    console.log(`Storyboard POC running on http://localhost:${config.port}`);
    probeImageService(config);
  });
}

module.exports = { startServer, probeImageService };
