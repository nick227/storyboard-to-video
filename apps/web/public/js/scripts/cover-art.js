import { api } from '../core/api.js';
import { ensureProjectSynced, getCurrentStoryboardRecord } from '../core/persistence.js';

export function syncScreenplayLogos(coverUrl = null) {
  for (const root of document.querySelectorAll('.screenplay-logo')) {
    const img = root.matches('img') ? root : root.querySelector('.screenplay-logo-image');
    if (!img) continue;
    if (coverUrl) {
      img.src = coverUrl;
      img.hidden = false;
      root.classList.add('has-cover');
    } else {
      img.removeAttribute('src');
      img.hidden = true;
      root.classList.remove('has-cover');
    }
  }
  const removeBtn = document.getElementById('scriptCoverRemoveBtn');
  if (removeBtn) removeBtn.hidden = !coverUrl;
}

export async function removeScriptCover(scriptId) {
  return api(`/api/scripts/${encodeURIComponent(scriptId)}/cover`, { method: 'DELETE' });
}

export function bindCoverArtControls({
  triggers = [],
  removeBtn,
  ensureScript,
  applyScript,
  setStatus,
  openImageLibrary,
  closeMetaModal,
  getStyleId,
  domEls,
} = {}) {
  async function openCoverLibrary() {
    try {
      closeMetaModal?.();
      const script = await ensureScript();
      await ensureProjectSynced();
      const projectId = getCurrentStoryboardRecord()?.id;
      if (!projectId) throw new Error('Save the work before setting cover art.');
      openImageLibrary?.({
        mode: 'screenplay-cover',
        scriptId: script.id,
        coverUrl: script.coverUrl || null,
        styleId: typeof getStyleId === 'function' ? getStyleId() : '',
        onCoverApplied: applyScript,
        domEls,
        setStatus,
      });
    } catch (error) {
      setStatus?.(error.message || 'Could not open cover art library.');
    }
  }

  for (const el of triggers.filter(Boolean)) {
    el.addEventListener('click', (event) => {
      event.preventDefault();
      openCoverLibrary();
    });
  }

  removeBtn?.addEventListener('click', async () => {
    try {
      const script = await ensureScript();
      const response = await removeScriptCover(script.id);
      applyScript(response.script);
      setStatus?.('Cover art removed.');
    } catch (error) {
      setStatus?.(error.message || 'Could not remove cover art.');
    }
  });
}

export function coverArtMarkup(coverUrl, { className = 'cover-art' } = {}) {
  if (!coverUrl) return '';
  return `<div class="${className}" style="background-image:url('${String(coverUrl).replaceAll("'", '%27')}')" role="img" aria-hidden="true"></div>`;
}
