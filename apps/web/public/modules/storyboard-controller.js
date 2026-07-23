import { sceneStore, uiStore } from './store.js';
import { assertElements } from './dom-contract.js';
import { imageShot } from './scene-shots.js';
import { enableDragScroll, enableStageSwipe } from './storyboard-gestures.js';

export function getZipSummary(scenes = sceneStore.get().scenes || []) {
  const exportScenes = scenes.slice(0, 200);
  let imageCount = 0;
  let videoCount = 0;
  let audioCount = 0;

  for (const scene of exportScenes) {
    const shot = imageShot(scene);
    const activeImage = shot.versions[shot.activeVersionIndex];
    if (activeImage?.path) imageCount++;

    const activeVideo = shot.videoVersions[shot.activeVideoVersionIndex];
    if (activeVideo?.path) videoCount++;

    const activeAudio = Array.isArray(scene.audioVersions)
      ? scene.audioVersions[Number.isInteger(scene.activeAudioVersionIndex) ? scene.activeAudioVersionIndex : 0]
      : null;
    if (activeAudio?.path) audioCount++;
  }

  return {
    totalScenes: scenes.length,
    exportedScenes: exportScenes.length,
    imageCount,
    videoCount,
    audioCount,
  };
}

export function renderDownloadConfirmModal(elements, scenes) {
  const summary = getZipSummary(scenes);
  const bullets = [
    `${summary.exportedScenes} storyboard scene structure${summary.exportedScenes === 1 ? '' : 's'}`,
    `${summary.imageCount} generated image${summary.imageCount === 1 ? '' : 's'} (in images/ folder)`,
    `${summary.videoCount} generated video${summary.videoCount === 1 ? '' : 's'} (in videos/ folder)`,
    `${summary.audioCount} narration audio clip${summary.audioCount === 1 ? '' : 's'} (in audio/ folder)`,
    '1 Fountain screenplay source (script/screenplay.fountain)',
    '1 storyboard metadata file (storyboard.json)',
  ];
  elements.downloadBullets.replaceChildren(...bullets.map((text) => {
    const item = document.createElement('li');
    item.textContent = text;
    return item;
  }));

  if (summary.totalScenes > 200) {
    elements.downloadWarning.textContent = `Warning: Your storyboard has ${summary.totalScenes} scenes. The export tool packages only the first 200 scenes.`;
    elements.downloadWarning.hidden = false;
  } else {
    elements.downloadWarning.replaceChildren();
    elements.downloadWarning.hidden = true;
  }
}

export function initStoryboardController(elements, {
  createProject,
  getCurrentRecord,
  openProject,
  saveProject,
  renderPicker,
  loadStoryboardIntoUI,
  renderScenes,
  downloadProject,
} = {}) {
  assertElements('Storyboard controller', elements, [
    'title', 'pickerToggle', 'pickerList', 'newBtn', 'saveBtn',
    'grid', 'slider', 'viewToggle', 'resizeList', 'downloadBtn', 'downloadModal',
    'downloadCloseBtn', 'downloadCancelBtn', 'downloadRunBtn',
    'downloadWarning', 'downloadBullets',
  ]);

  let downloadResolve = null;
  let view = 'grid';
  const sliderPrev = elements.slider.querySelector('.storyboard-slider-prev');
  const sliderNext = elements.slider.querySelector('.storyboard-slider-next');
  const sliderStage = elements.slider.querySelector('.storyboard-slider-stage');
  const filmstrip = elements.slider.querySelector('.storyboard-filmstrip');

  const setView = (nextView) => {
    view = nextView === 'slider' ? 'slider' : 'grid';
    const sliderActive = view === 'slider';
    elements.grid.hidden = sliderActive;
    elements.slider.hidden = !sliderActive;
    elements.slider.dataset.active = String(sliderActive);
    elements.viewToggle.classList.toggle('is-active', sliderActive);
    elements.viewToggle.setAttribute('aria-pressed', String(sliderActive));
    elements.viewToggle.setAttribute('aria-label', sliderActive ? 'Switch to storyboard grid' : 'Switch to scene slider');
    elements.viewToggle.title = sliderActive ? 'View all scenes' : 'Edit one scene at a time';
    elements.resizeList.querySelectorAll('.resize-scenes').forEach((button) => {
      button.disabled = sliderActive;
    });
    renderScenes?.();
    if (sliderActive) elements.slider.focus({ preventScroll: true });
  };

  const selectRelativeScene = (offset) => {
    const scenes = sceneStore.get().scenes || [];
    if (!scenes.length) return;
    const selectedId = uiStore.get().selectedSceneId;
    const currentIndex = Math.max(0, scenes.findIndex((scene) => scene.id === selectedId));
    const nextIndex = Math.min(scenes.length - 1, Math.max(0, currentIndex + offset));
    if (scenes[nextIndex]?.id !== selectedId) uiStore.set({ selectedSceneId: scenes[nextIndex].id });
  };
  enableDragScroll(filmstrip, { axis: 'x' });
  enableStageSwipe(sliderStage, {
    onSwipeLeft: () => selectRelativeScene(1),
    onSwipeRight: () => selectRelativeScene(-1),
  });
  const closePicker = () => {
    elements.pickerList.hidden = true;
    elements.pickerToggle.setAttribute('aria-expanded', 'false');
  };
  const openPicker = () => {
    elements.pickerList.hidden = false;
    elements.pickerToggle.setAttribute('aria-expanded', 'true');
  };
  const openDownloadModal = () => {
    renderDownloadConfirmModal(elements);
    elements.downloadModal.returnValue = '';
    elements.downloadModal.showModal();
    return new Promise((resolve) => { downloadResolve = resolve; });
  };

  elements.newBtn.addEventListener('click', async () => {
    createProject();
    renderPicker();
    saveProject(true);
    await loadStoryboardIntoUI();
  });
  elements.pickerToggle.addEventListener('click', () => {
    if (elements.pickerList.hidden) openPicker();
    else closePicker();
  });
  elements.pickerList.addEventListener('click', async (event) => {
    const item = event.target.closest('li[data-id]');
    if (!item) return;
    closePicker();
    if (item.dataset.id === getCurrentRecord()?.id) return;
    await openProject(item.dataset.id);
    renderPicker();
    await loadStoryboardIntoUI();
  });
  elements.title.addEventListener('input', () => {
    saveProject(false);
    const current = getCurrentRecord();
    const selectedItem = elements.pickerList.querySelector('li[aria-selected="true"]');
    if (selectedItem && current) selectedItem.textContent = current.title;
  });
  elements.title.addEventListener('blur', () => {
    const current = getCurrentRecord();
    if (current) elements.title.value = current.title;
  });
  elements.title.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') elements.title.blur();
  });
  elements.saveBtn.addEventListener('click', () => saveProject(true));
  elements.viewToggle.addEventListener('click', () => setView(view === 'grid' ? 'slider' : 'grid'));
  sliderPrev.addEventListener('click', () => selectRelativeScene(-1));
  sliderNext.addEventListener('click', () => selectRelativeScene(1));
  elements.slider.querySelector('.storyboard-filmstrip').addEventListener('click', (event) => {
    const button = event.target.closest('[data-scene-id]');
    if (button?.dataset.sceneId) uiStore.set({ selectedSceneId: button.dataset.sceneId });
  });
  elements.slider.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (event.target.closest('textarea, input, select')) return;
    event.preventDefault();
    selectRelativeScene(event.key === 'ArrowLeft' ? -1 : 1);
  });
  elements.resizeList.addEventListener('click', (event) => {
    const button = event.target.closest('.resize-scenes');
    if (!button || !elements.resizeList.contains(button)) return;
    const columns = Number(button.dataset.columns);
    if (!Number.isInteger(columns) || columns < 1 || columns > 6) return;
    elements.grid.style.setProperty('--scene-columns', columns);
    elements.grid.dataset.columns = String(columns);
    elements.resizeList.querySelectorAll('.resize-scenes').forEach((candidate) => {
      const isActive = candidate === button;
      candidate.classList.toggle('is-active', isActive);
      candidate.setAttribute('aria-pressed', String(isActive));
    });
  });

  elements.downloadCancelBtn.addEventListener('click', () => elements.downloadModal.close());
  elements.downloadCloseBtn.addEventListener('click', () => elements.downloadModal.close());
  elements.downloadRunBtn.addEventListener('click', () => elements.downloadModal.close('confirm'));
  elements.downloadModal.addEventListener('click', (event) => {
    if (event.target === elements.downloadModal) elements.downloadModal.close();
  });
  elements.downloadModal.addEventListener('close', () => {
    const resolve = downloadResolve;
    downloadResolve = null;
    resolve?.(elements.downloadModal.returnValue === 'confirm');
  });
  elements.downloadBtn.addEventListener('click', async () => {
    if (await openDownloadModal()) await downloadProject();
  });

  document.addEventListener('click', (event) => {
    if (elements.pickerList.hidden) return;
    if (event.target === elements.pickerToggle || elements.pickerList.contains(event.target)) return;
    closePicker();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !elements.pickerList.hidden) closePicker();
  });

  return { renderPicker };
}
