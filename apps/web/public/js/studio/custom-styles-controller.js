import { api } from '../core/api.js';
import { assertElements } from '../core/dom-contract.js';
import { loadProtectedAsset } from '../core/assets.js';
import { generationStore } from '../core/store.js';
import { getCurrentStoryboardRecord } from '../core/persistence.js';

const EMPTY_REFERENCES = Object.freeze({ characters: [], world: [] });

export function isPersistedCustomStyle(styles, selectedId) {
  return Boolean(selectedId && selectedId !== 'new' && styles.some((style) => style.id === selectedId));
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function initCustomStylesController(elements, services = {}) {
  assertElements('Custom styles controller', elements, [
    'customStylesBtn', 'stageCustomStylesBtn', 'customStylesModal', 'customStylesCloseBtn',
    'customStyleNewBtn', 'customStylesList', 'customStyleEditor',
    'customStyleFields', 'customStyleTitle', 'customStylePrompt', 'customStyleSaveBtn',
    'customStyleStatus', 'customStyleCharacterInput',
    'customStyleWorldInput', 'customStyleCharacterRefs', 'customStyleWorldRefs',
    'styleSelect', 'stageStyleSelect', 'customStyleCharacterGenerateBtn',
    'customStyleWorldGenerateBtn', 'imageProvider', 'customStyleCharacterLibraryBtn',
    'customStyleWorldLibraryBtn', 'customStyleCharacterUploadBtn', 'customStyleWorldUploadBtn',
    'imageLibraryModal', 'styleRefLightbox', 'styleRefLightboxImage',
  ]);

  const state = {
    styles: [],
    selectedId: null,
    references: { ...EMPTY_REFERENCES },
    dirty: false,
    loading: false,
  };

  const selectedStyle = () => state.styles.find((style) => style.id === state.selectedId) || null;

  function setStatus(message) {
    elements.customStyleStatus.textContent = message || '';
  }

  function setEditorDisabled(disabled) {
    elements.customStyleTitle.disabled = disabled;
    elements.customStylePrompt.disabled = disabled;
    elements.customStyleSaveBtn.disabled = disabled || !elements.customStyleTitle.value.trim();
    elements.customStyleNewBtn.disabled = disabled;
    elements.customStylesList.querySelectorAll('button').forEach((btn) => { btn.disabled = disabled; });
    elements.customStylesCloseBtn.disabled = disabled;

    const charLimit = state.references.characters.length >= 4;
    const worldLimit = state.references.world.length >= 4;
    const canGen = state.selectedId && state.selectedId !== 'new' && !state.dirty && !disabled;

    elements.customStyleCharacterInput.disabled = !state.selectedId || disabled || charLimit;
    elements.customStyleWorldInput.disabled = !state.selectedId || disabled || worldLimit;
    elements.customStyleCharacterGenerateBtn.disabled = !canGen || charLimit;
    elements.customStyleWorldGenerateBtn.disabled = !canGen || worldLimit;
    elements.customStyleCharacterLibraryBtn.disabled = !state.selectedId || disabled || charLimit;
    elements.customStyleWorldLibraryBtn.disabled = !state.selectedId || disabled || worldLimit;
    elements.customStyleCharacterUploadBtn.disabled = !state.selectedId || disabled || charLimit;
    elements.customStyleWorldUploadBtn.disabled = !state.selectedId || disabled || worldLimit;
  }

  function updateGenerateButtonTitles() {
    const charLimit = state.references.characters.length >= 4;
    const worldLimit = state.references.world.length >= 4;
    
    let titleMsg = '';
    if (!state.selectedId || state.selectedId === 'new') {
      titleMsg = 'Save this style before generating references';
    } else if (state.dirty) {
      titleMsg = 'Save custom style changes first before generating references';
    } else if (state.loading) {
      titleMsg = 'Generation in progress…';
    }

    elements.customStyleCharacterGenerateBtn.title = charLimit ? 'Reference limit reached (4 of 4)' : titleMsg;
    elements.customStyleWorldGenerateBtn.title = worldLimit ? 'Reference limit reached (4 of 4)' : titleMsg;
  }

  function setDirty(dirty = true) {
    state.dirty = dirty;
    setEditorDisabled(state.loading);
    updateGenerateButtonTitles();
  }

  function canDiscard() {
    return !state.dirty || window.confirm('Discard unsaved custom style changes?');
  }

  function referenceCard(reference, category, index, count) {
    const card = document.createElement('div');
    card.className = 'custom-style-reference-card';
    const image = document.createElement('img');
    image.alt = reference.fileName || `${category} style reference`;
    image.loading = 'lazy';
    image.style.cursor = 'pointer';
    image.dataset.assetPath = reference.url;
    loadProtectedAsset(reference.url).then((url) => {
      if (url && image.dataset.assetPath === reference.url) image.src = url;
    }).catch(() => {});

    // Open lightbox and populate detailed provenance
    image.addEventListener('click', () => {
      loadProtectedAsset(reference.url).then((url) => {
        if (!url) return;
        elements.styleRefLightboxImage.src = url;
        elements.styleRefLightboxImage.alt = reference.fileName || 'Style Reference';
        
        const info = elements.styleRefLightbox.querySelector('#styleRefLightboxInfo');
        if (info) {
          info.innerHTML = '';
          const details = [];
          if (reference.source === 'ai_generated') {
            details.push(`<strong>Source:</strong> AI Generated`);
            if (reference.provider) details.push(`<strong>Provider:</strong> ${reference.provider}`);
            if (reference.model) details.push(`<strong>Model:</strong> ${reference.model}`);
            if (reference.aspectRatio) details.push(`<strong>Aspect Ratio:</strong> ${reference.aspectRatio}`);
            if (reference.promptSnapshot) details.push(`<strong>Prompt Snapshot:</strong> <br/><span style="font-size: 11px; color: var(--text-muted);">${escapeHtml(reference.promptSnapshot)}</span>`);
            if (reference.generationRequestId) details.push(`<strong>Request ID:</strong> <br/><span style="font-size: 10px; color: var(--text-muted);">${reference.generationRequestId}</span>`);
          } else {
            details.push(`<strong>Source:</strong> User Uploaded`);
            details.push(`<strong>Filename:</strong> ${escapeHtml(reference.fileName)}`);
          }
          info.innerHTML = details.join('<br/><br/>');
        }
        
        elements.styleRefLightbox.showModal();
      }).catch(() => {});
    });

    if (reference.source === 'ai_generated') {
      const badge = document.createElement('span');
      badge.className = 'custom-style-reference-badge';
      badge.textContent = 'AI';
      badge.title = `Generated with ${reference.provider || 'AI'}`;
      card.appendChild(badge);
    }

    const actions = document.createElement('div');
    actions.className = 'custom-style-reference-actions';
    const earlier = document.createElement('button');
    earlier.type = 'button';
    earlier.textContent = '↑';
    earlier.title = 'Move earlier';
    earlier.disabled = index === 0;
    earlier.dataset.referenceMove = reference.id;
    earlier.dataset.direction = 'up';
    earlier.dataset.category = category;
    const later = document.createElement('button');
    later.type = 'button';
    later.textContent = '↓';
    later.title = 'Move later';
    later.disabled = index === count - 1;
    later.dataset.referenceMove = reference.id;
    later.dataset.direction = 'down';
    later.dataset.category = category;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'Delete reference';
    remove.dataset.referenceDelete = reference.id;
    actions.append(earlier, later, remove);
    card.append(image, actions);
    return card;
  }

  function renderReferenceList(container, category) {
    const references = state.references[category] || [];
    if (!references.length) {
      const empty = document.createElement('div');
      empty.className = 'custom-style-reference-empty';
      empty.textContent = 'No references yet';
      container.replaceChildren(empty);
      return;
    }
    container.replaceChildren(...references.map((reference, index) => referenceCard(reference, category, index, references.length)));
  }

  function renderReferences() {
    renderReferenceList(elements.customStyleCharacterRefs, 'characters');
    renderReferenceList(elements.customStyleWorldRefs, 'world');
    
    // Render capacity text on headers
    const charHeading = elements.customStyleCharacterRefs.previousElementSibling?.querySelector('small');
    if (charHeading) {
      charHeading.textContent = `${state.references.characters.length} of 4 used`;
    }
    const worldHeading = elements.customStyleWorldRefs.previousElementSibling?.querySelector('small');
    if (worldHeading) {
      worldHeading.textContent = `${state.references.world.length} of 4 used`;
    }

    setEditorDisabled(state.loading);
    updateGenerateButtonTitles();
  }

  function renderList() {
    if (!state.styles.length) {
      const empty = document.createElement('p');
      empty.className = 'custom-style-reference-empty';
      empty.textContent = 'No custom styles yet';
      elements.customStylesList.replaceChildren(empty);
      return;
    }
    const nodes = state.styles.map((style) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'custom-style-list-item';
      button.dataset.customStyleId = style.id;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(style.id === state.selectedId));
      button.textContent = style.name;
      return button;
    });
    elements.customStylesList.replaceChildren(...nodes);
  }

  function renderEditor() {
    const style = selectedStyle();
    const editing = Boolean(style || state.selectedId === 'new');
    elements.customStyleFields.hidden = !editing;
    if (!editing) {
      elements.customStyleTitle.value = '';
      elements.customStylePrompt.value = '';
      elements.customStyleSaveBtn.disabled = true;
    }
    renderList();
    renderReferences();
  }

  async function loadReferences(styleId) {
    if (!styleId || styleId === 'new') {
      state.references = { characters: [], world: [] };
      renderReferences();
      return;
    }
    const data = await api(`/api/custom-styles/${encodeURIComponent(styleId)}/references`);
    if (state.selectedId !== styleId) return;
    state.references = data.references || { characters: [], world: [] };
    renderReferences();
  }

  async function selectStyle(styleId) {
    if ((styleId === state.selectedId && styleId !== null) || !canDiscard()) return;
    state.selectedId = styleId;
    const style = selectedStyle();
    elements.customStyleTitle.value = style?.name || '';
    elements.customStylePrompt.value = style?.promptText || '';
    state.references = { characters: [], world: [] };
    state.dirty = false;
    setStatus('');
    renderEditor();
    await loadReferences(styleId);
    setDirty(false);
  }

  async function loadCustomStyles(preferredId = state.selectedId) {
    state.loading = true;
    elements.customStyleNewBtn.disabled = true;
    setStatus('Loading…');
    try {
      const data = await api('/api/custom-styles');
      state.styles = data.styles || [];
      const nextId = state.styles.some((style) => style.id === preferredId)
        ? preferredId
        : 'new';
      state.selectedId = null;
      await selectStyle(nextId);
      renderList();
      setStatus('');
    } finally {
      state.loading = false;
      elements.customStyleNewBtn.disabled = false;
      setDirty(false);
    }
  }

  async function openModal() {
    if (!elements.customStylesModal.open) elements.customStylesModal.showModal();
    await loadCustomStyles('new');
  }

  async function saveStyle() {
    const title = elements.customStyleTitle.value.trim();
    if (!title) {
      setStatus('Title is required.');
      elements.customStyleTitle.focus();
      return;
    }
    state.loading = true;
    setStatus('Saving…');
    setEditorDisabled(true);
    try {
      const body = JSON.stringify({ title, promptText: elements.customStylePrompt.value.trim() });
      const existingStyle = isPersistedCustomStyle(state.styles, state.selectedId);
      const data = existingStyle
        ? await api(`/api/custom-styles/${encodeURIComponent(state.selectedId)}`, { method: 'PATCH', body })
        : await api('/api/custom-styles', { method: 'POST', body });
      state.selectedId = data.style.id;
      state.dirty = false;
      await services.refreshStyles?.();
      const record = getCurrentStoryboardRecord();
      if (record?.styleId === data.style.id) {
        record.styleSnapshot = { title: data.style.name, promptText: data.style.promptText, updatedAt: data.style.updatedAt };
        services.saveProject?.(false);
        await services.loadStyleReferences?.(data.style.id);
      }
      await loadCustomStyles(data.style.id);
      setStatus('Saved');
    } catch (error) {
      setStatus(`Save failed: ${error.message}`);
      setDirty(true);
    } finally {
      state.loading = false;
      setEditorDisabled(false);
    }
  }


  async function generateReferences(category) {
    if (!state.selectedId || state.selectedId === 'new' || state.dirty) return;
    
    const requestStyleId = state.selectedId;
    const idempotencyKey = crypto.randomUUID();
    
    state.loading = true;
    const provider = elements.imageProvider.value;
    setStatus(`Generating ${category === 'world' ? 'world reference with ' + provider : 'character reference with ' + provider}…`);
    setEditorDisabled(true);
    updateGenerateButtonTitles();

    try {
      const data = await api(`/api/custom-styles/${encodeURIComponent(requestStyleId)}/references/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ type: category, provider, idempotencyKey })
      });
      
      // Ignore response if user switched styles
      if (state.selectedId !== requestStyleId) return;
      
      state.references = data.references || { characters: [], world: [] };
      renderReferences();
      if (elements.styleSelect.value === state.selectedId) await services.loadStyleReferences?.(state.selectedId);
      setStatus('Reference generated');
    } catch (error) {
      if (state.selectedId === requestStyleId) {
        setStatus(`Generation failed: ${error.message}`);
      }
    } finally {
      if (state.selectedId === requestStyleId) {
        state.loading = false;
        setEditorDisabled(false);
        updateGenerateButtonTitles();
      }
    }
  }

  async function uploadReferences(category, files) {
    if (!state.selectedId || state.selectedId === 'new' || !files?.length) return;
    state.loading = true;
    setStatus('Uploading references…');
    const form = new FormData();
    [...files].forEach((file) => form.append('files', file));
    try {
      const data = await api(`/api/custom-styles/${encodeURIComponent(state.selectedId)}/references?type=${encodeURIComponent(category)}`, { method: 'POST', body: form });
      state.references = data.references || { characters: [], world: [] };
      renderReferences();
      if (elements.styleSelect.value === state.selectedId) await services.loadStyleReferences?.(state.selectedId);
      setStatus('References uploaded');
    } catch (error) {
      setStatus(`Upload failed: ${error.message}`);
    } finally {
      state.loading = false;
      elements.customStyleCharacterInput.value = '';
      elements.customStyleWorldInput.value = '';
    }
  }

  async function removeReference(referenceId) {
    try {
      const data = await api(`/api/custom-styles/${encodeURIComponent(state.selectedId)}/references/${encodeURIComponent(referenceId)}`, { method: 'DELETE' });
      state.references = data.references || { characters: [], world: [] };
      renderReferences();
      if (elements.styleSelect.value === state.selectedId) await services.loadStyleReferences?.(state.selectedId);
      setStatus('Reference deleted');
    } catch (error) {
      setStatus(`Delete failed: ${error.message}`);
    }
  }

  async function moveReference(referenceId, category, direction) {
    const references = [...(state.references[category] || [])];
    const index = references.findIndex((reference) => reference.id === referenceId);
    const other = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || other < 0 || other >= references.length) return;
    [references[index], references[other]] = [references[other], references[index]];
    try {
      const data = await api(`/api/custom-styles/${encodeURIComponent(state.selectedId)}/references/order`, {
        method: 'PATCH',
        body: JSON.stringify({ type: category, ids: references.map((reference) => reference.id) }),
      });
      state.references = data.references || { characters: [], world: [] };
      renderReferences();
      if (elements.styleSelect.value === state.selectedId) await services.loadStyleReferences?.(state.selectedId);
    } catch (error) {
      setStatus(`Reorder failed: ${error.message}`);
    }
  }

  elements.customStylesBtn.addEventListener('click', openModal);
  elements.stageCustomStylesBtn.addEventListener('click', openModal);
  elements.customStyleNewBtn.addEventListener('click', async () => {
    if (!canDiscard()) return;
    state.selectedId = 'new';
    state.references = { characters: [], world: [] };
    elements.customStyleTitle.value = '';
    elements.customStylePrompt.value = '';
    state.dirty = true;
    renderEditor();
    elements.customStyleTitle.focus();
    setDirty(true);
  });
  elements.customStylesList.addEventListener('click', (event) => {
    const item = event.target.closest('[data-custom-style-id]');
    if (item) selectStyle(item.dataset.customStyleId);
  });
  elements.customStyleTitle.addEventListener('input', () => setDirty(true));
  elements.customStylePrompt.addEventListener('input', () => setDirty(true));
  elements.customStyleSaveBtn.addEventListener('click', saveStyle);
  elements.customStyleCharacterInput.addEventListener('change', (event) => uploadReferences('characters', event.target.files));
  elements.customStyleWorldInput.addEventListener('change', (event) => uploadReferences('world', event.target.files));
  elements.customStyleCharacterGenerateBtn.addEventListener('click', () => generateReferences('characters'));
  elements.customStyleWorldGenerateBtn.addEventListener('click', () => generateReferences('world'));
  elements.customStyleCharacterUploadBtn.addEventListener('click', () => elements.customStyleCharacterInput.click());
  elements.customStyleWorldUploadBtn.addEventListener('click', () => elements.customStyleWorldInput.click());
  elements.customStyleCharacterLibraryBtn.addEventListener('click', () => {
    services.openImageLibrary?.({
      mode: 'character-reference',
      styleId: state.selectedId,
      domEls: elements,
      setStatus,
    });
  });
  elements.customStyleWorldLibraryBtn.addEventListener('click', () => {
    services.openImageLibrary?.({
      mode: 'world-reference',
      styleId: state.selectedId,
      domEls: elements,
      setStatus,
    });
  });
  elements.imageLibraryModal.addEventListener('close', () => {
    if (state.selectedId && state.selectedId !== 'new') {
      loadReferences(state.selectedId);
    }
  });
  elements.customStyleEditor.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-reference-delete]');
    if (remove) return removeReference(remove.dataset.referenceDelete);
    const move = event.target.closest('[data-reference-move]');
    if (move) moveReference(move.dataset.referenceMove, move.dataset.category, move.dataset.direction);
  });
  const close = () => { if (canDiscard()) elements.customStylesModal.close(); };
  elements.customStylesCloseBtn.addEventListener('click', close);
  elements.customStylesModal.addEventListener('cancel', (event) => {
    if (!canDiscard()) event.preventDefault();
  });
  elements.customStylesModal.addEventListener('click', (event) => {
    if (event.target === elements.customStylesModal) close();
  });

  return { open: openModal, reload: loadCustomStyles };
}
