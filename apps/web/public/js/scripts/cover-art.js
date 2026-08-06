import { api } from '../core/api.js';
import { ensureProjectSynced, getCurrentStoryboardRecord } from '../core/persistence.js';

export function syncScreenplayLogos(coverUrl = null) {
  if (typeof document === 'undefined') return;
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
  function openCoverLibrary() {
    closeMetaModal?.();
    const existing = getCurrentStoryboardRecord()?.script || null;
    openImageLibrary?.({
      mode: 'screenplay-cover',
      scriptId: existing?.id || '',
      coverUrl: existing?.coverUrl || null,
      styleId: typeof getStyleId === 'function' ? getStyleId() : '',
      onCoverApplied: applyScript,
      domEls,
      setStatus,
      prepare: async () => {
        const script = await ensureScript();
        await ensureProjectSynced();
        const projectId = getCurrentStoryboardRecord()?.id;
        if (!projectId) throw new Error('Save the work before setting cover art.');
        return {
          scriptId: script.id,
          coverUrl: script.coverUrl || null,
          projectId,
        };
      },
    });
  }

  for (const el of triggers.filter(Boolean)) {
    el.addEventListener('click', (event) => {
      event.preventDefault();
      el.classList.add('is-busy');
      openCoverLibrary();
      requestAnimationFrame(() => el.classList.remove('is-busy'));
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

export function coverArtMarkup(coverUrl, { className = 'cover-art', fit = 'cover' } = {}) {
  if (!coverUrl) return '';
  const safeUrl = String(coverUrl).replaceAll("'", '%27').replaceAll('"', '&quot;');
  if (fit === 'contain') {
    return `<div class="${className}"><img src="${safeUrl}" alt="" /></div>`;
  }
  return `<div class="${className}" style="background-image:url('${safeUrl}')" role="img" aria-hidden="true"></div>`;
}
