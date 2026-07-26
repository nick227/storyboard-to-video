import { api } from '../core/api.js';

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

export async function uploadScriptCover(scriptId, file) {
  const form = new FormData();
  form.append('file', file);
  return api(`/api/scripts/${encodeURIComponent(scriptId)}/cover`, {
    method: 'POST',
    body: form,
  });
}

export async function removeScriptCover(scriptId) {
  return api(`/api/scripts/${encodeURIComponent(scriptId)}/cover`, { method: 'DELETE' });
}

export function bindCoverArtControls({
  fileInput,
  triggers = [],
  removeBtn,
  ensureScript,
  applyScript,
  setStatus,
} = {}) {
  if (!fileInput) return;

  function openPicker() {
    fileInput.value = '';
    fileInput.click();
  }

  for (const el of triggers.filter(Boolean)) {
    el.addEventListener('click', (event) => {
      event.preventDefault();
      openPicker();
    });
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const script = await ensureScript();
      const response = await uploadScriptCover(script.id, file);
      applyScript(response.script);
      setStatus?.('Cover art updated.');
    } catch (error) {
      setStatus?.(error.message || 'Could not upload cover art.');
    } finally {
      fileInput.value = '';
    }
  });

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
