import { sceneStore } from './store.js';
import { assertElements } from './dom-contract.js';

export function getZipSummary(scenes = sceneStore.get().scenes || []) {
  const exportScenes = scenes.slice(0, 200);
  let imageCount = 0;
  let videoCount = 0;
  let audioCount = 0;

  for (const scene of exportScenes) {
    const activeImage = Array.isArray(scene.versions)
      ? scene.versions[Number.isInteger(scene.activeVersionIndex) ? scene.activeVersionIndex : 0]
      : null;
    if (activeImage?.path) imageCount++;

    const activeVideo = Array.isArray(scene.videoVersions)
      ? scene.videoVersions[Number.isInteger(scene.activeVideoVersionIndex) ? scene.activeVideoVersionIndex : 0]
      : null;
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
  downloadProject,
} = {}) {
  assertElements('Storyboard controller', elements, [
    'title', 'pickerToggle', 'pickerList', 'newBtn', 'saveBtn',
    'grid', 'resizeList', 'downloadBtn', 'downloadModal',
    'downloadCloseBtn', 'downloadCancelBtn', 'downloadRunBtn',
    'downloadWarning', 'downloadBullets',
  ]);

  let downloadResolve = null;
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
