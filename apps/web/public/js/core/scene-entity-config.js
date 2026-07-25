export const SCENE_ENTITY_TYPES = Object.freeze(['action', 'prompt', 'dialogue', 'image', 'audio', 'video', 'subtitle']);

export const SCENE_ENTITY_LABELS = Object.freeze({
  action: 'Still action',
  prompt: 'Visual prompt',
  dialogue: 'Narration',
  image: 'Image',
  audio: 'Audio',
  video: 'Video',
  subtitle: 'Subtitles',
});

export function entityOverride(scene, type) {
  const value = scene?.entityOverrides?.[type];
  return value && typeof value === 'object' ? value : {};
}

export function hasEntityOverride(scene, type) {
  return Object.keys(entityOverride(scene, type)).length > 0;
}

export function resolvedEntityConfig(scene, type, { record = {}, voiceState = {}, elements = {} } = {}) {
  record ||= {};
  voiceState ||= {};
  elements ||= {};
  const override = entityOverride(scene, type);
  const textProvider = elements.textProvider?.value || record.textProvider || 'gemini';
  const imageProvider = elements.imageProvider?.value || record.imageProvider || 'gemini';
  const audioProvider = elements.audioProvider?.value || voiceState.audioProvider || record.audioProvider || 'stub';
  const videoProvider = elements.videoProvider?.value || record.mediaSettings?.video?.provider || '';
  const aspectRatio = elements.mediaAspectRatio?.value || record.mediaSettings?.aspectRatio || '';
  const imageResolution = elements.imageResolutionTier?.value || record.mediaSettings?.image?.resolutionTier || 'standard';
  const imageQuality = elements.imageQuality?.value || record.mediaSettings?.image?.quality || 'medium';
  const videoResolution = elements.videoResolutionTier?.value || record.mediaSettings?.video?.resolutionTier || 'draft';
  const videoDuration = Number(elements.videoDurationSeconds?.value || record.mediaSettings?.video?.durationSeconds || 0) || null;
  const motionIntensity = elements.videoMotionIntensity?.value || record.videoMotionIntensity || 'medium';
  const subtitleStyle = elements.subtitleStyleSelect?.value || record.subtitleStyle || 'classic';
  const voices = voiceState.narratorVoice || record.narratorVoice || {};

  switch (type) {
    case 'action':
    case 'prompt':
    case 'dialogue':
      return { provider: override.provider || textProvider };
    case 'image':
      return {
        provider: override.provider || imageProvider,
        aspectRatio: override.aspectRatio ?? aspectRatio,
        resolutionTier: override.resolutionTier || imageResolution,
        quality: override.quality || imageQuality,
      };
    case 'audio': {
      const provider = override.provider || audioProvider;
      return { provider, voice: override.voice !== undefined ? override.voice : (voices[provider] || null) };
    }
    case 'video':
      return {
        provider: override.provider ?? videoProvider,
        model: override.model || record.mediaSettings?.video?.model || '',
        aspectRatio: override.aspectRatio ?? aspectRatio,
        resolutionTier: override.resolutionTier || videoResolution,
        durationSeconds: override.durationSeconds ?? videoDuration,
        motionIntensity: override.motionIntensity || motionIntensity,
      };
    case 'subtitle':
      return { style: override.style || subtitleStyle };
    default:
      return {};
  }
}

export function setEntityOverride(scene, type, value) {
  scene.entityOverrides = { ...(scene.entityOverrides || {}), [type]: { ...value } };
}

export function clearEntityOverride(scene, type) {
  const next = { ...(scene.entityOverrides || {}) };
  delete next[type];
  scene.entityOverrides = next;
}

export function recordEntityGeneration(scene, type, config) {
  scene.entityGenerationProvenance = {
    ...(scene.entityGenerationProvenance || {}),
    [type]: { ...config, generatedAt: new Date().toISOString() },
  };
}
