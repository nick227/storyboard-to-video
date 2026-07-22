import { projectStore, sceneStore, uiStore, batchStore } from './store.js';
import { getCurrentStoryboardRecord } from './persistence.js';
import { assertElements } from './dom-contract.js';
import {
  buildRunRowStatus,
  classifyPlanningRun,
  computeForceStages,
  computeRunRange,
  getCachedJobs,
  getStageSelection,
  refreshRecentJobs,
  refreshSpend,
  stopActiveWork,
  toggleStageSelection,
} from './stages.js';

const STAGES = ['planning', 'images', 'audio', 'video', 'subtitles'];
const DEFAULT_NEXT_COUNT = 5;

export function buildGenerationPreflight(kind, { scenes = [], labels = {}, fromCount, toCount } = {}) {
  const total = scenes.length;
  const versionStats = (key) => ({
    scenes: scenes.filter((scene) => (scene[key] || []).some((version) => version?.path)).length,
    versions: scenes.reduce((sum, scene) => sum + (scene[key] || []).filter((version) => version?.path).length, 0),
  });
  const mediaConfig = (label, versionsKey, providerLabel, extra = '') => {
    const stats = versionStats(versionsKey);
    const bullets = [`${total} shots · ${providerLabel}${extra}`];
    if (stats.versions) bullets.push(`${stats.scenes}/${total} shots already have a version — those are replaced too`);
    bullets.push('Prefer "Generate missing/stale" unless you want to redo everything');
    return {
      title: `Regenerate all ${label.toLowerCase()}`,
      paragraph: `This replaces every scene's ${label.toLowerCase()}, including ones already up to date.`,
      bullets,
      confirmLabel: `Regenerate all ${label.toLowerCase()}`,
    };
  };
  const configs = {
    imagesAll: mediaConfig('Images', 'versions', labels.imageProvider, ' with the selected style and references'),
    audioAll: mediaConfig('Audio', 'audioVersions', labels.audioProvider, ' and the selected narrator voice'),
    videoAll: mediaConfig('Video', 'videoVersions', labels.videoMotionIntensity, ' motion intensity'),
    subtitlesAll: mediaConfig('Subtitles', 'subtitleVersions', labels.subtitleStyle, ' caption style'),
    planningReplan: {
      title: fromCount != null && toCount != null && fromCount !== toCount ? `Reduce to ${toCount} shots` : 'Replan story structure',
      paragraph: fromCount != null && toCount != null && fromCount !== toCount
        ? `Reducing from ${fromCount} to ${toCount} shots will rebuild the storyboard structure and retire media.`
        : 'This re-segments the story from the original script, discarding the current scene structure.',
      bullets: [
        `LLM provider · ${labels.textProvider}`,
        `${toCount ?? total} shots, rebuilt from the original script`,
        'Prompts, images, audio, and video tied to replaced scenes are retired, not orphaned',
      ],
      confirmLabel: 'Replan story structure',
    },
  };
  return configs[kind];
}

export function initRunController(elements, {
  setStatus,
  replan,
  regenerate,
  runFlow,
  renderStatus,
  renderStoryboard,
} = {}) {
  assertElements('Run controller', elements, [
    'textProvider', 'imageProvider', 'audioProvider', 'videoMotionIntensity',
    'subtitleStyle', 'confirmModal', 'confirmTitle', 'confirmIntro',
    'confirmBullets', 'confirmCloseBtn', 'confirmCancelBtn', 'confirmRunBtn',
    'startModal', 'sceneLabel', 'sceneTotal', 'rangeAll', 'rangeNext',
    'nextCount', 'startCloseBtn', 'startCancelBtn', 'startConfirmBtn',
    'planningCheck', 'planningStatus', 'imagesCheck', 'imagesStatus',
    'audioCheck', 'audioStatus', 'videoCheck', 'videoStatus',
    'subtitlesCheck', 'subtitlesStatus', 'replanBtn', 'regenerateImagesBtn',
    'regenerateAudioBtn', 'regenerateVideoBtn', 'regenerateSubtitlesBtn',
    'startPauseBtn',
  ]);
  let generationResolve = null;
  let startResolve = null;
  const selectedLabel = (select) => select.selectedOptions?.[0]?.textContent?.trim() || select.value;
  const labels = () => ({
    textProvider: selectedLabel(elements.textProvider),
    imageProvider: selectedLabel(elements.imageProvider),
    audioProvider: selectedLabel(elements.audioProvider),
    videoMotionIntensity: selectedLabel(elements.videoMotionIntensity),
    subtitleStyle: selectedLabel(elements.subtitleStyle),
  });
  const rowElements = {
    planning: { check: elements.planningCheck, status: elements.planningStatus },
    images: { check: elements.imagesCheck, status: elements.imagesStatus },
    audio: { check: elements.audioCheck, status: elements.audioStatus },
    video: { check: elements.videoCheck, status: elements.videoStatus },
    subtitles: { check: elements.subtitlesCheck, status: elements.subtitlesStatus },
  };
  const refreshAfterRun = async () => {
    await Promise.all([
      refreshRecentJobs(projectStore.get().currentId),
      refreshSpend(projectStore.get().currentId),
    ]);
    renderStatus();
    renderStoryboard();
  };
  const computePlan = () => {
    const scenes = sceneStore.get().scenes;
    const record = getCurrentStoryboardRecord();
    const mode = elements.rangeNext.checked ? 'next' : 'all';
    const count = Number(elements.nextCount.value) || 1;
    const range = computeRunRange(scenes, uiStore.get().selectedSceneId, mode, count);
    const rowStatus = buildRunRowStatus(scenes, range, batchStore.get(), uiStore.get().operation, getCachedJobs(), record?.stageRuns || {});
    const selectionStatus = Object.fromEntries(STAGES.map((stage) => [stage, rowStatus[stage].ranged]));
    return { scenes, range, rowStatus, selectionStatus };
  };
  const formatRow = (stage, row) => {
    if (stage === 'planning') {
      const action = classifyPlanningRun(row.full);
      const model = `LLM: ${selectedLabel(elements.textProvider)}`;
      if (action === 'full') return `${model} · Creates the full storyboard structure — not limited to the selected range.`;
      if (action === 'stale') return `${model} · Updates ${row.full.stale} stale prompt${row.full.stale === 1 ? '' : 's'} in the selected range.`;
      return `${model} · ${row.full.label} — up to date.`;
    }
    if (stage === 'images') return `Image: ${selectedLabel(elements.imageProvider)} · ${row.ranged.label} selected · ${row.full.label} total`;
    return `${row.ranged.label} selected · ${row.full.label} total`;
  };
  const renderStartModal = () => {
    const plan = computePlan();
    const selection = getStageSelection(plan.selectionStatus);
    elements.sceneLabel.textContent = String(Math.min(plan.range.startIndex + 1, Math.max(plan.scenes.length, 1)));
    elements.sceneTotal.textContent = String(plan.scenes.length);
    for (const stage of STAGES) {
      rowElements[stage].check.checked = Boolean(selection[stage]);
      rowElements[stage].status.textContent = formatRow(stage, plan.rowStatus[stage]);
    }
    return plan;
  };
  const openStartModal = () => {
    if (!sceneStore.get().scenes.length) elements.rangeAll.checked = true;
    else {
      elements.rangeNext.checked = true;
      elements.nextCount.value = String(DEFAULT_NEXT_COUNT);
    }
    renderStartModal();
    elements.startModal.returnValue = '';
    elements.startModal.showModal();
    return new Promise((resolve) => { startResolve = resolve; });
  };
  const confirmGeneration = (kind, context = {}) => {
    const details = buildGenerationPreflight(kind, { scenes: sceneStore.get().scenes, labels: labels(), ...context });
    if (!details) return Promise.resolve(false);
    elements.confirmTitle.textContent = details.title;
    elements.confirmIntro.textContent = details.paragraph;
    elements.confirmBullets.replaceChildren(...details.bullets.map((text) => {
      const item = document.createElement('li');
      item.textContent = text;
      return item;
    }));
    elements.confirmRunBtn.textContent = details.confirmLabel;
    elements.confirmCancelBtn.textContent = details.cancelLabel || 'Cancel';
    elements.confirmModal.returnValue = '';
    elements.confirmModal.showModal();
    return new Promise((resolve) => { generationResolve = resolve; });
  };

  elements.confirmCancelBtn.addEventListener('click', () => elements.confirmModal.close());
  elements.confirmCloseBtn.addEventListener('click', () => elements.confirmModal.close());
  elements.confirmRunBtn.addEventListener('click', () => elements.confirmModal.close('confirm'));
  elements.confirmModal.addEventListener('click', (event) => {
    if (event.target === elements.confirmModal) elements.confirmModal.close();
  });
  elements.confirmModal.addEventListener('close', () => {
    const resolve = generationResolve;
    generationResolve = null;
    resolve?.(elements.confirmModal.returnValue === 'confirm');
  });
  elements.startCancelBtn.addEventListener('click', () => elements.startModal.close());
  elements.startCloseBtn.addEventListener('click', () => elements.startModal.close());
  elements.startConfirmBtn.addEventListener('click', () => elements.startModal.close('confirm'));
  elements.startModal.addEventListener('click', (event) => {
    if (event.target === elements.startModal) elements.startModal.close();
  });
  elements.startModal.addEventListener('close', () => {
    const resolve = startResolve;
    startResolve = null;
    resolve?.(elements.startModal.returnValue === 'confirm');
  });
  [elements.rangeAll, elements.rangeNext, elements.nextCount].forEach((input) => input.addEventListener('input', renderStartModal));
  STAGES.map((stage) => rowElements[stage].check).forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const { selectionStatus } = computePlan();
      toggleStageSelection(checkbox.dataset.stage, selectionStatus);
      renderStartModal();
    });
  });
  elements.replanBtn.addEventListener('click', async () => {
    if (!(await confirmGeneration('planningReplan'))) return;
    await replan();
    await refreshAfterRun();
  });
  const wireRegenerate = (button, stage, kind) => button.addEventListener('click', async () => {
    if (!(await confirmGeneration(kind))) return;
    setStatus(`Regenerating all ${stage}...`);
    await regenerate(stage);
    await refreshAfterRun();
  });
  wireRegenerate(elements.regenerateImagesBtn, 'images', 'imagesAll');
  wireRegenerate(elements.regenerateAudioBtn, 'audio', 'audioAll');
  wireRegenerate(elements.regenerateVideoBtn, 'video', 'videoAll');
  wireRegenerate(elements.regenerateSubtitlesBtn, 'subtitles', 'subtitlesAll');
  elements.startPauseBtn.addEventListener('click', async () => {
    if (elements.startPauseBtn.dataset.running === 'true') {
      const result = stopActiveWork(projectStore.get().currentId);
      setStatus(result.kind === 'cancelled' ? 'Cancelling planning...' : result.kind === 'paused' ? 'Stopping...' : 'Nothing to stop.');
      renderStatus();
      return;
    }
    if (uiStore.get().operation || !(await openStartModal())) return;
    const { range, rowStatus, selectionStatus } = computePlan();
    const selection = getStageSelection(selectionStatus);
    const stages = STAGES.filter((stage) => selection[stage]);
    if (!stages.length) return setStatus('Nothing selected to start — check a step above.');
    const forceStages = computeForceStages(rowStatus, selection);
    setStatus('Starting...');
    const result = await runFlow({ stages, range, forceStages });
    if (!result.stoppedAt) setStatus('Done.');
    else if (result.stoppedAt !== 'failed') setStatus(`Stopped: ${result.stoppedAt}.`);
    await refreshAfterRun();
  });
}
