import { assertElements } from '../core/dom-contract.js';
import { generationStore } from '../core/store.js';
import { getCurrentStoryboardRecord, queueSync } from '../core/persistence.js';
import { loadProtectedAsset } from '../core/assets.js';

function moveInOrder(order, fileName, direction) {
  const list = [...order];
  if (!list.includes(fileName)) list.push(fileName);
  const index = list.indexOf(fileName);
  const swapWith = direction === 'up' ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= list.length) return list;
  [list[index], list[swapWith]] = [list[swapWith], list[index]];
  return list;
}

export function initStyleController(elements, services = {}) {
  assertElements('Style controller', elements, [
    'styleSelect', 'stageStyleSelect', 'commonPromptText',
    'characterRefInput', 'worldRefInput', 'characterRefs', 'worldRefs', 'styleReferencesPanel',
    'styleRefLightbox', 'styleRefLightboxImage',
  ]);

  elements.styleSelect.addEventListener('change', async () => {
    if (elements.stageStyleSelect.value !== elements.styleSelect.value) {
      elements.stageStyleSelect.value = elements.styleSelect.value;
    }
    const styleId = elements.styleSelect.value;
    services.prefillCommonPrompt(styleId);
    services.saveProject(false);
    services.renderStageBar();
    await services.loadStyleReferences(styleId);
  });
  elements.stageStyleSelect.addEventListener('change', () => {
    if (elements.styleSelect.value === elements.stageStyleSelect.value) return;
    elements.styleSelect.value = elements.stageStyleSelect.value;
    elements.styleSelect.dispatchEvent(new Event('change'));
  });

  elements.commonPromptText.addEventListener('input', () => {
    services.saveProject(false);
    services.renderStageBar();
  });

  elements.characterRefInput.addEventListener('change', (event) => services.uploadStyleReferences('characters', event.target.files));
  elements.worldRefInput.addEventListener('change', (event) => services.uploadStyleReferences('world', event.target.files));

  elements.onStyleReferenceReorder = async (type, fileName, direction) => {
    const record = getCurrentStoryboardRecord();
    if (!record) return;
    const currentOrder = record.styleReferenceOrder || {};
    const existingOrder = currentOrder[type] || generationStore.get().styleReferences[type]?.map((item) => item.fileName) || [];
    record.styleReferenceOrder = { ...currentOrder, [type]: moveInOrder(existingOrder, fileName, direction) };
    queueSync(record, services.setStatus);
    await services.loadStyleReferences(elements.styleSelect.value);
  };

  elements.onStyleReferenceInspect = (item) => {
    loadProtectedAsset(item.url).then((url) => {
      if (!url) return;
      elements.styleRefLightboxImage.src = url;
      elements.styleRefLightboxImage.alt = item.fileName;
      elements.styleRefLightbox.showModal();
    });
  };
  elements.styleRefLightbox.querySelectorAll('[data-close-lightbox]').forEach((button) => {
    button.addEventListener('click', () => elements.styleRefLightbox.close());
  });
  elements.styleRefLightbox.addEventListener('click', (event) => {
    if (event.target === elements.styleRefLightbox) elements.styleRefLightbox.close();
  });

  return {};
}
