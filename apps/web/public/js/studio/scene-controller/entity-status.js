import { ENTITY_CONFIG } from './entity-registry.js';
import { SCENE_ENTITY_TYPES } from '../../core/scene-entity-config.js';
import { getCurrentStoryboardRecord } from '../../core/persistence.js';
import { computeStaleness, getCachedJobs, buildLatestJobsByScene } from '../../generation/stages.js';
import { resolvedEntityConfig } from '../../core/scene-entity-config.js';

export function isEntityLoading(type, scene, operation) {
  if (!operation) return false;
  switch (type) {
    case 'prompt': return operation.type === 'prompts' || ((operation.type === 'prompt' || operation.type === 'action') && operation.sceneId === scene.id);
    case 'action': return operation.type === 'action' && operation.sceneId === scene.id;
    case 'image': return ['image', 'imagesSerial'].includes(operation.type) && operation.sceneId === scene.id;
    case 'dialogue': return operation.type === 'dialogueAll' || (operation.type === 'dialogue' && operation.sceneId === scene.id);
    case 'audio': return ['audio', 'audioSerial'].includes(operation.type) && operation.sceneId === scene.id;
    case 'video': return ['video', 'videosSerial'].includes(operation.type) && operation.sceneId === scene.id;
    case 'subtitle': return ['subtitle', 'subtitlesSerial'].includes(operation.type) && operation.sceneId === scene.id;
    default: return false;
  }
}

export function hasExistingEntity(type, scene) {
  const config = ENTITY_CONFIG[type];
  if (config.kind === 'text') return Boolean(String(config.getValue(scene) || '').trim());
  return (config.versions(scene) || []).some((version) => Boolean(version?.path));
}

export function sceneFreshnessByType(scene) {
  const freshness = computeStaleness(scene);
  return {
    action: false,
    prompt: freshness.promptStale,
    dialogue: false,
    image: freshness.imageStale,
    audio: freshness.audioStale,
    video: freshness.videoStale || freshness.videoPromptStale || !String(scene.videoPrompt || '').trim(),
    subtitle: freshness.subtitleStale,
  };
}

function comparableConfig(config = {}) {
  return Object.fromEntries(Object.entries(config)
    .filter(([key, value]) => key !== 'generatedAt' && value !== undefined));
}

export function entityStatuses(scene, operation, recentJobs = getCachedJobs(), latestJobs = null, domEls = {}) {
  const staleByType = sceneFreshnessByType(scene);
  const record = getCurrentStoryboardRecord() || {};
  const statuses = {};

  const MISSING_ENTITY_STATUS = { key: 'missing', label: 'Missing' };

  for (const type of SCENE_ENTITY_TYPES) {
    const present = hasExistingEntity(type, scene);
    const loading = isEntityLoading(type, scene, operation);
    const lastJob = (latestJobs?.[type] || buildLatestJobsByScene(recentJobs, type)).get(scene.id);
    const failed = !loading && lastJob?.status === 'failed';
    const nextConfig = resolvedEntityConfig(scene, type, { record, elements: domEls });
    const previousConfig = scene.entityGenerationProvenance?.[type];
    const configChanged = Boolean(present && previousConfig
      && JSON.stringify(comparableConfig(previousConfig)) !== JSON.stringify(comparableConfig(nextConfig)));
    const stale = Boolean(present && (staleByType[type] || configChanged));

    let key = 'ready';
    let label = 'Ready';
    let reason = '';
    if (loading) {
      key = 'generating';
      label = 'Generating';
    } else if (failed) {
      key = 'failed';
      label = 'Issue';
      reason = lastJob?.error?.message || (typeof lastJob?.error === 'string' ? lastJob.error : null) || lastJob?.message || 'The latest generation attempt failed.';
    } else if (!present) {
      ({ key, label } = MISSING_ENTITY_STATUS);
    } else if (stale) {
      key = 'stale';
      label = 'Needs update';
      reason = configChanged ? 'Scene generation settings changed.' : 'An upstream scene input changed.';
    }
    statuses[type] = { type, present, loading, failed, stale, key, label, reason, config: nextConfig };
  }
  return statuses;
}

export function sceneStatusSummary(statuses) {
  const values = Object.values(statuses);
  const ready = values.filter((status) => status.present && !status.stale && !status.failed).length;
  const failed = values.filter((status) => status.failed).length;
  const loading = values.filter((status) => status.loading).length;
  const stale = values.filter((status) => status.stale && !status.failed).length;
  const missing = values.filter((status) => !status.present && !status.loading && !status.failed).length;

  if (failed) return `${ready}/7 ready · ${failed} issue${failed === 1 ? '' : 's'}`;
  if (loading) return `Generating ${loading} of 7`;
  if (stale) return `${ready}/7 ready · ${stale} update${stale === 1 ? '' : 's'}`;
  if (missing === 7) return 'Not started';
  if (missing) return `${ready}/7 ready · ${missing} not run`;
  return '7/7 ready';
}
