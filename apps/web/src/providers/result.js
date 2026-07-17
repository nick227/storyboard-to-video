const MEASUREMENT_STATUSES = new Set(['observed', 'estimated', 'unavailable', 'not_applicable']);

function providerRequestId(response, body) {
  return body?.responseId || body?.id || response?.headers?.get('x-request-id') || response?.headers?.get('request-id') || null;
}

function providerResult({ output, provider, model, providerRequestId: requestId = null, usage = {}, rawUsage = null, measurementStatus = 'unavailable' }) {
  if (!provider || !model) throw new Error('Provider results require provider and model identifiers');
  if (!MEASUREMENT_STATUSES.has(measurementStatus)) throw new Error(`Invalid measurement status: ${measurementStatus}`);
  return { output, provider, model, providerRequestId: requestId, usage, rawUsage, measurementStatus };
}

function outputMetadata(output) {
  if (Buffer.isBuffer(output)) return { kind: 'buffer', bytes: output.length };
  if (typeof output === 'string') return { kind: 'text', characters: output.length };
  if (!output || typeof output !== 'object') return { kind: typeof output };
  return {
    kind: 'object',
    ...(Buffer.isBuffer(output.buffer) ? { bytes: output.buffer.length } : {}),
    ...(output.mimeType ? { mimeType: output.mimeType } : {}),
    ...(output.extension ? { extension: output.extension } : {}),
    ...(output.outputPath ? { outputPath: String(output.outputPath) } : {}),
  };
}

function providerOutput(result) { return result && Object.hasOwn(result, 'output') ? result.output : result; }

module.exports = { MEASUREMENT_STATUSES, outputMetadata, providerOutput, providerRequestId, providerResult };
