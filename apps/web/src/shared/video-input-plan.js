const { VIDEO_INPUT_ROLES, videoProviderCapabilities } = require('./video-provider-capabilities');

const AUDIO_POLICIES = Object.freeze(['none', 'provider_native', 'replace_with_project_audio']);

function outputIntent(value = {}) {
  const audioPolicy = value.audioPolicy || 'none';
  if (!AUDIO_POLICIES.includes(audioPolicy)) throw new RangeError(`Unsupported video audio policy: ${audioPolicy}`);
  const providerOptions = value.providerOptions || { version: 1, values: {} };
  if (providerOptions.version !== 1 || !providerOptions.values || Array.isArray(providerOptions.values) || typeof providerOptions.values !== 'object') {
    throw new RangeError('providerOptions must use { version: 1, values: object }');
  }
  return {
    ...(value.durationSeconds == null ? {} : { durationSeconds: Number(value.durationSeconds) }),
    ...(value.aspectRatio ? { aspectRatio: String(value.aspectRatio) } : {}),
    ...(value.resolution ? { resolution: String(value.resolution) } : {}),
    ...(value.resolutionTier ? { resolutionTier: String(value.resolutionTier) } : {}),
    ...(value.requestedOutput ? { requestedOutput: structuredClone(value.requestedOutput) } : {}),
    ...(value.resolvedOutput ? { resolvedOutput: structuredClone(value.resolvedOutput) } : {}),
    audioPolicy,
    ...(value.seed == null ? {} : { seed: Number(value.seed) }),
    providerOptions: { version: 1, values: structuredClone(providerOptions.values) },
  };
}

function providerSlot(role, index) {
  if (role === 'start_frame') return 'start_frame';
  if (role === 'end_frame') return 'end_frame';
  return `references[${index}]`;
}

function resolveVideoInputPlan({ provider, model, mode = 'image_to_video', inputs = [], output = {}, capabilities: suppliedCapabilities }) {
  const capabilities = suppliedCapabilities || videoProviderCapabilities(provider, model, mode);
  const included = [];
  const excluded = [];
  for (const [candidateOrder, candidate] of inputs.entries()) {
    const role = String(candidate?.role || '');
    if (!VIDEO_INPUT_ROLES.includes(role)) throw new RangeError(`Unsupported video input role: ${role || 'missing'}`);
    const normalized = {
      assetId: candidate.assetId || null,
      assetPath: candidate.assetPath || candidate.path || null,
      sha256: candidate.sha256 || null,
      instruction: candidate.instruction || '',
      role,
      candidateOrder,
      ...(candidate.sourcePath ? { sourcePath: candidate.sourcePath } : {}),
    };
    if (!capabilities.supportedRoles.includes(role)) excluded.push({ ...normalized, reason: 'unsupported_input_role' });
    else if (included.length >= capabilities.maxInputs) excluded.push({ ...normalized, reason: 'provider_limit' });
    else included.push({ ...normalized, order: included.length, providerSlot: providerSlot(role, included.length) });
  }
  for (const role of capabilities.requiredRoles) {
    if (!included.some((input) => input.role === role)) throw new RangeError(`${provider}/${capabilities.model}/${mode} requires input role: ${role}`);
  }
  return { provider, model: capabilities.model, mode, capabilities, included, excluded, output: outputIntent(output) };
}

function snapshotVideoPlan(plan) {
  const stripRuntime = ({ sourcePath, ...input }) => input;
  return { ...plan, included: plan.included.map(stripRuntime), excluded: plan.excluded.map(stripRuntime) };
}

module.exports = { AUDIO_POLICIES, outputIntent, resolveVideoInputPlan, snapshotVideoPlan };
