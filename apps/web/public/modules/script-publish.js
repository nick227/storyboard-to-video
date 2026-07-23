import { api } from './api.js';
import { ensureProjectSynced, getCurrentStoryboardRecord, saveStoryboard } from './persistence.js';
import { shareUrl } from './scripts/chrome.js';

export function initScriptPublishControls(elements, { setStatus } = {}) {
  const toggle = elements.scriptVisibilityToggle;
  const shareBtn = elements.scriptShareBtn;
  if (!toggle || !shareBtn) return { syncFromRecord() {} };

  let busy = false;

  function applyScript(script) {
    const record = getCurrentStoryboardRecord();
    if (record && script) {
      record.scriptId = script.id;
      record.script = script;
      if (script.scriptText != null) record.scriptText = script.scriptText;
    }
    const isPublic = script?.visibility === 'public';
    toggle.checked = isPublic;
    shareBtn.disabled = !isPublic || !script?.slug;
    shareBtn.dataset.sharePath = script?.sharePath || (script?.slug ? `/scripts/${script.slug}` : '');
  }

  function syncFromRecord(record = getCurrentStoryboardRecord()) {
    applyScript(record?.script || null);
  }

  async function ensureScript(record) {
    if (record?.script?.id || record?.scriptId) {
      const scriptId = record.script?.id || record.scriptId;
      const response = await api(`/api/scripts/${encodeURIComponent(scriptId)}`);
      applyScript(response.script);
      return response.script;
    }
    saveStoryboard(elements, false);
    await ensureProjectSynced();
    const fresh = getCurrentStoryboardRecord();
    if (!fresh?.scriptId && !fresh?.script?.id) {
      throw new Error('Save the storyboard before publishing.');
    }
    const scriptId = fresh.script?.id || fresh.scriptId;
    const response = await api(`/api/scripts/${encodeURIComponent(scriptId)}`);
    applyScript(response.script);
    return response.script;
  }

  toggle.addEventListener('change', async () => {
    if (busy) return;
    const record = getCurrentStoryboardRecord();
    if (!record) {
      toggle.checked = false;
      return;
    }
    busy = true;
    toggle.disabled = true;
    try {
      const script = await ensureScript(record);
      const response = await api(`/api/scripts/${encodeURIComponent(script.id)}/visibility`, {
        method: 'POST',
        body: JSON.stringify({ visibility: toggle.checked ? 'public' : 'private' }),
      });
      applyScript(response.script);
      setStatus?.(toggle.checked ? 'Script is public.' : 'Script is private.');
    } catch (error) {
      toggle.checked = !toggle.checked;
      setStatus?.(error.message || 'Could not update visibility.');
    } finally {
      toggle.disabled = false;
      busy = false;
    }
  });

  shareBtn.addEventListener('click', async () => {
    const path = shareBtn.dataset.sharePath;
    if (!path) return;
    const url = new URL(path, window.location.origin).toString();
    try {
      const result = await shareUrl(url, { title: getCurrentStoryboardRecord()?.title || 'Screenplay' });
      setStatus?.(result === 'shared' ? 'Shared.' : 'Share link copied.');
    } catch (error) {
      if (error?.name === 'AbortError') return;
      setStatus?.(error.message || url);
    }
  });

  return { syncFromRecord, ensureScript };
}
