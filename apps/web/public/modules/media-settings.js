import { assertElements } from './dom-contract.js';

export function selectedMediaSettings(elements, { clearInheritedDuration = false } = {}) {
  return {
    version: 1,
    ...(elements.aspectRatio?.value ? { aspectRatio: elements.aspectRatio.value } : {}),
    image: {
      resolutionTier: elements.imageResolutionTier?.value || '',
      quality: elements.imageQuality?.value || '',
    },
    video: {
      resolutionTier: elements.videoResolutionTier?.value || '',
      ...(elements.videoDurationSeconds?.value
        ? { durationSeconds: Number(elements.videoDurationSeconds.value) }
        : (clearInheritedDuration ? { durationSeconds: null } : {})),
      ...(elements.videoProvider?.value ? { provider: elements.videoProvider.value } : {}),
    },
  };
}

async function readJson(response, fallbackMessage) {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || fallbackMessage);
  return body;
}

/**
 * Owns media-output capability discovery, quotes, preference persistence, and
 * the DOM events which cause those operations. The caller supplies only this
 * feature's elements and the few application services it needs.
 */
export function initMediaSettings(elements, {
  saveProject,
  getProjectScope,
  getQuantity,
  fetchRequest = (...args) => fetch(...args),
} = {}) {
  assertElements('Media settings', elements, [
    'aspectRatio', 'imageProvider', 'imageResolutionTier', 'imageQuality',
    'videoProvider', 'videoResolutionTier', 'videoDurationSeconds',
    'costPreview', 'saveDefaultsBtn',
  ]);
  let quoteSequence = 0;
  let videoOptionsSequence = 0;
  let imageOptionsSequence = 0;
  let imageCombinations = [];

  const setPreview = (message) => {
    if (elements.costPreview) elements.costPreview.textContent = message;
  };
  const selectedSettings = (options) => selectedMediaSettings(elements, options);
  const projectScope = () => getProjectScope?.() || {};

  const refreshVideoDurationOptions = async () => {
    const sequence = ++videoOptionsSequence;
    try {
      const body = await fetchRequest('/api/media-output/video-duration-options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(elements.videoProvider?.value ? { provider: elements.videoProvider.value } : {}),
          ...projectScope(),
          outputIntent: selectedSettings({ clearInheritedDuration: true }),
        }),
      }).then((response) => readJson(response, 'Could not resolve video lengths'));
      if (sequence !== videoOptionsSequence) return;

      const results = new Map((body.options || []).map((item) => [String(item.durationSeconds), item]));
      for (const option of elements.videoDurationSeconds.options) {
        const result = option.value ? results.get(option.value) : body.providerDefault;
        const baseLabel = option.dataset.baseLabel || option.textContent;
        option.disabled = result?.supported === false;
        option.title = result?.reason || '';
        if (!option.value && result?.supported) {
          const seconds = result.output?.resolved?.durationSeconds;
          option.textContent = seconds ? `${baseLabel} · ${seconds}s` : `${baseLabel} · Automatic`;
        } else {
          option.textContent = `${baseLabel}${result?.supported === false ? ' · Unsupported' : ''}`;
        }
      }
    } catch (_) {
      if (sequence !== videoOptionsSequence) return;
      for (const option of elements.videoDurationSeconds.options) {
        const baseLabel = option.dataset.baseLabel || option.textContent;
        option.disabled = Boolean(option.value);
        option.textContent = `${baseLabel}${option.value ? ' · Unavailable' : ' · Automatic'}`;
        option.title = option.value ? 'Could not verify this duration against the server media policy.' : '';
      }
    }
  };

  const applyImageOutputOptions = () => {
    const resolutionTier = elements.imageResolutionTier.value;
    const quality = elements.imageQuality.value;
    for (const option of elements.imageResolutionTier.options) {
      const result = imageCombinations.find((item) => item.resolutionTier === option.value && item.quality === quality);
      const baseLabel = option.dataset.baseLabel || option.textContent;
      option.disabled = result?.supported === false;
      option.textContent = `${baseLabel}${result?.supported === false ? ' · Unsupported' : ''}`;
      option.title = result?.reason || '';
    }
    for (const option of elements.imageQuality.options) {
      const result = imageCombinations.find((item) => item.resolutionTier === resolutionTier && item.quality === option.value);
      const baseLabel = option.dataset.baseLabel || option.textContent;
      option.disabled = result?.supported === false;
      option.textContent = `${baseLabel}${result?.supported === false ? ' · Unsupported' : ''}`;
      option.title = result?.reason || '';
    }
  };

  const refreshImageOutputOptions = async () => {
    const sequence = ++imageOptionsSequence;
    try {
      const body = await fetchRequest('/api/media-output/image-output-options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: elements.imageProvider.value,
          ...projectScope(),
          outputIntent: selectedSettings({ clearInheritedDuration: true }),
        }),
      }).then((response) => readJson(response, 'Could not resolve image settings'));
      if (sequence !== imageOptionsSequence) return;
      imageCombinations = body.combinations || [];
      applyImageOutputOptions();
    } catch (_) {
      if (sequence !== imageOptionsSequence) return;
      imageCombinations = [];
      for (const select of [elements.imageResolutionTier, elements.imageQuality]) {
        for (const option of select.options) {
          option.disabled = option.value !== select.value;
          option.textContent = `${option.dataset.baseLabel || option.textContent}${option.disabled ? ' · Unavailable' : ''}`;
          option.title = option.disabled ? 'Could not verify this setting against the server media policy.' : '';
        }
      }
    }
  };

  const refreshCostPreview = async () => {
    const sequence = ++quoteSequence;
    const quantity = Math.max(1, Number(getQuantity?.()) || 1);
    const outputIntent = selectedSettings({ clearInheritedDuration: true });
    const scope = projectScope();
    try {
      const requestQuote = (modality, provider, fallbackMessage) => fetchRequest('/api/media-output/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modality, ...(provider ? { provider } : {}), ...scope, outputIntent, quantity }),
      }).then((response) => readJson(response, fallbackMessage));
      const [imageQuote, videoQuote] = await Promise.all([
        requestQuote('image', elements.imageProvider.value, 'Image output is unsupported'),
        requestQuote('video', elements.videoProvider?.value, 'Video output is unsupported'),
      ]);
      if (sequence !== quoteSequence) return;
      const describe = (result, label) => {
        const resolved = result.output.resolved;
        const dimensions = resolved.width && resolved.height ? `${resolved.width}×${resolved.height}` : resolved.providerSettings.resolution;
        const cost = result.estimate.available
          ? `${(Number(result.estimate.totalCreditMicros) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 3 })} tokens for ${quantity}`
          : 'price unavailable';
        return `${label}: ${dimensions}${resolved.durationSeconds ? `, ${resolved.durationSeconds}s` : ''}, ${cost}`;
      };
      setPreview(`${describe(imageQuote, 'Images')} · ${describe(videoQuote, 'Videos')}`);
    } catch (error) {
      if (sequence === quoteSequence) setPreview(error.message);
    }
  };

  const saveDefaults = async () => {
    if (!elements.aspectRatio.value) {
      setPreview('Choose a shared aspect ratio before saving defaults for new projects.');
      return;
    }
    if (elements.imageResolutionTier.selectedOptions[0]?.disabled || elements.imageQuality.selectedOptions[0]?.disabled) {
      setPreview('Choose image resolution and quality settings supported by the selected provider.');
      return;
    }
    if (elements.videoDurationSeconds.selectedOptions[0]?.disabled) {
      setPreview('Choose a video length supported by the selected provider and resolution.');
      return;
    }
    try {
      const response = await fetchRequest('/api/auth/preferences/media', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selectedSettings()),
      });
      await readJson(response, 'Could not save media defaults');
      setPreview('Saved as your defaults for new projects. Existing projects are unchanged.');
    } catch (error) {
      setPreview(error.message);
    }
  };

  const saveAndRefreshQuote = () => {
    saveProject?.();
    refreshCostPreview();
  };
  [elements.aspectRatio, elements.imageResolutionTier, elements.imageQuality, elements.videoResolutionTier, elements.videoDurationSeconds, elements.videoProvider]
    .forEach((element) => element.addEventListener('change', saveAndRefreshQuote));
  [elements.aspectRatio, elements.videoResolutionTier, elements.videoProvider]
    .forEach((element) => element.addEventListener('change', refreshVideoDurationOptions));
  [elements.aspectRatio, elements.imageProvider]
    .forEach((element) => element.addEventListener('change', refreshImageOutputOptions));
  [elements.imageResolutionTier, elements.imageQuality]
    .forEach((element) => element.addEventListener('change', applyImageOutputOptions));
  elements.imageProvider.addEventListener('change', saveAndRefreshQuote);
  elements.saveDefaultsBtn.addEventListener('click', saveDefaults);

  return {
    refreshAll: () => Promise.all([
      refreshImageOutputOptions(),
      refreshVideoDurationOptions(),
      refreshCostPreview(),
    ]),
    refreshCostPreview,
    refreshImageOutputOptions,
    refreshVideoDurationOptions,
    selectedSettings,
  };
}
