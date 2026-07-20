const { AppError } = require('../errors');
const {
  ASPECT_RATIOS, IMAGE_QUALITY_LEVELS, RESOLUTION_TIERS, estimatedUsage,
  mergeMediaIntent, resolveImageOutput, resolveVideoOutput,
} = require('../shared/media-output-policy');

function serializeQuote(quote, quantity) {
  if (!quote) return { available: false, reason: 'billing_not_configured' };
  if (!quote.price) return { available: false, reason: 'no_active_price' };
  return {
    available: true,
    providerPriceVersionId: quote.price.id,
    currency: quote.price.currency,
    quantity,
    unitProviderNanoUsd: quote.estimatedProviderNanoUsd.toString(),
    totalProviderNanoUsd: (quote.estimatedProviderNanoUsd * BigInt(quantity)).toString(),
    unitCreditMicros: quote.quotedCreditMicros.toString(),
    totalCreditMicros: (quote.quotedCreditMicros * BigInt(quantity)).toString(),
    calculation: quote.calculation,
  };
}

function createMediaOutputService({ config, projectStore, billing, videoProviders }) {
  function imageModel(provider, requested) {
    if (requested) return requested;
    return { stub: 'stub-image-v1', openai: config.env.OPENAI_IMAGE_MODEL || 'gpt-image-1', dezgo: config.env.DEZGO_MODEL || 'text2image', gemini: config.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image' }[provider];
  }

  async function selection(input, { ownerId } = {}) {
    const modality = input.modality;
    if (!['image', 'video'].includes(modality)) throw new AppError('VALIDATION_ERROR', 'modality must be image or video', { status: 400 });
    const project = input.projectId ? await projectStore.read(input.projectId, { ownerId }) : null;
    if (modality === 'image') {
      const model = imageModel(input.provider, input.model);
      if (!model) throw new AppError('VALIDATION_ERROR', `Unsupported image provider: ${input.provider}`, { status: 400 });
      const output = resolveImageOutput({ provider: input.provider, model, intent: mergeMediaIntent({ modality, platform: config.mediaOutputDefaults, project: project?.mediaSettings, override: input.outputIntent }) });
      return { modality, provider: input.provider, model, output };
    }
    const projectVideoDefaults = project?.mediaSettings?.video || {};
    const provider = input.provider || projectVideoDefaults.provider || config.videoProvider;
    const model = input.model || (provider === projectVideoDefaults.provider ? projectVideoDefaults.model : undefined);
    const mode = input.mode || 'image_to_video';
    const resolvedProvider = videoProviders.resolve({ provider, model, mode });
    const output = resolveVideoOutput({ provider, model: resolvedProvider.model, mode, intent: mergeMediaIntent({ modality, platform: config.mediaOutputDefaults, project: project?.mediaSettings, override: input.outputIntent }) });
    return { modality, provider, model: resolvedProvider.model, mode, output };
  }

  async function quote(input, context) {
    const resolved = await selection(input, context);
    const quantity = Math.min(200, Math.max(1, Number.parseInt(input.quantity, 10) || 1));
    const unitUsage = { [resolved.modality === 'image' ? 'images' : 'videos']: 1, ...estimatedUsage(resolved.output), ...(resolved.provider === 'dezgo' ? { steps: Number(config.env.DEZGO_STEPS || 25) } : {}) };
    const billingQuote = billing ? await billing.quote({ modality: resolved.modality, provider: resolved.provider, model: resolved.model, estimatedUsage: unitUsage, estimatedUsageComplete: resolved.modality === 'image' }) : null;
    return { ...resolved, estimate: serializeQuote(billingQuote, quantity) };
  }

  function policy() {
    return { defaults: config.mediaOutputDefaults, aspectRatios: ASPECT_RATIOS, resolutionTiers: RESOLUTION_TIERS, imageQualityLevels: IMAGE_QUALITY_LEVELS };
  }

  return { policy, quote, selection };
}

module.exports = { createMediaOutputService };
