import { api } from '../core/api.js';
import { ensureProjectSynced, getCurrentStoryboardRecord, saveStoryboard } from '../core/persistence.js';
import { shareUrl } from './chrome.js';
import { fetchCategories, fetchScriptStats, updateScriptMeta } from './api.js';

function parseTagSlugs(value = '') {
  return [...new Set(String(value).split(/[,#]+/).map((part) => part.trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean))].slice(0, 8);
}

export function initScriptPublishControls(elements, { setStatus } = {}) {
  const toggle = elements.scriptVisibilityToggle;
  const shareBtn = elements.scriptShareBtn;
  const metaBtn = elements.scriptMetaBtn;
  const modal = elements.scriptMetaModal;
  if (!toggle || !shareBtn) return { syncFromRecord() {} };

  let busy = false;
  let categoriesLoaded = false;

  async function ensureCategories() {
    if (categoriesLoaded || !elements.scriptCategorySelect) return;
    const categories = await fetchCategories();
    const select = elements.scriptCategorySelect;
    select.innerHTML = '<option value="">Uncategorized</option>'
      + categories.map((category) => `<option value="${category.id}">${category.name}</option>`).join('');
    categoriesLoaded = true;
  }

  function applyMetaFields(script) {
    if (elements.scriptLogline) elements.scriptLogline.value = script?.logline || '';
    if (elements.scriptCategorySelect) elements.scriptCategorySelect.value = script?.categoryId || script?.category?.id || '';
    if (elements.scriptTagsInput) {
      elements.scriptTagsInput.value = (script?.tags || []).map((tag) => tag.slug || tag.name).join(', ');
    }
  }

  async function refreshStats(scriptId) {
    if (!elements.scriptStatsLine || !scriptId) return;
    try {
      const { stats } = await fetchScriptStats(scriptId);
      elements.scriptStatsLine.hidden = false;
      elements.scriptStatsLine.textContent = `${stats.viewCount || 0} views · ${stats.likeCount || 0} likes`;
    } catch (_) {
      elements.scriptStatsLine.hidden = true;
    }
  }

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
    applyMetaFields(script);
    if (script?.id) refreshStats(script.id);
  }

  async function syncFromRecord(record = getCurrentStoryboardRecord()) {
    await ensureCategories().catch(() => {});
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

  function closeMetaModal() {
    modal?.close();
  }

  async function openMetaModal() {
    if (!modal) return;
    await syncFromRecord();
    modal.showModal();
  }

  toggle.addEventListener('change', async () => {
    if (busy) return;
    const record = getCurrentStoryboardRecord();
    if (!record) {
      toggle.checked = false;
      return;
    }
    // Capture the user's choice before ensureScript() refreshes the script and
    // applies its previous server-side visibility to the checkbox.
    const desiredVisibility = toggle.checked ? 'public' : 'private';
    busy = true;
    toggle.disabled = true;
    try {
      const script = await ensureScript(record);
      toggle.checked = desiredVisibility === 'public';
      const response = await api(`/api/scripts/${encodeURIComponent(script.id)}/visibility`, {
        method: 'POST',
        body: JSON.stringify({ visibility: desiredVisibility }),
      });
      applyScript(response.script);
      setStatus?.(desiredVisibility === 'public' ? 'Script is public.' : 'Script is private.');
    } catch (error) {
      applyScript(getCurrentStoryboardRecord()?.script || null);
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

  metaBtn?.addEventListener('click', () => { openMetaModal().catch((error) => setStatus?.(error.message || 'Could not open publishing details.')); });
  elements.scriptMetaCloseBtn?.addEventListener('click', closeMetaModal);
  elements.scriptMetaCancelBtn?.addEventListener('click', closeMetaModal);
  modal?.addEventListener('click', (event) => {
    if (event.target === modal) closeMetaModal();
  });

  elements.scriptMetaSaveBtn?.addEventListener('click', async () => {
    const record = getCurrentStoryboardRecord();
    if (!record) return;
    try {
      const script = await ensureScript(record);
      const response = await updateScriptMeta(script.id, {
        logline: elements.scriptLogline?.value || '',
        categoryId: elements.scriptCategorySelect?.value || null,
        tagSlugs: parseTagSlugs(elements.scriptTagsInput?.value || ''),
      });
      applyScript(response.script);
      setStatus?.('Publishing details saved.');
      closeMetaModal();
    } catch (error) {
      setStatus?.(error.message || 'Could not save publishing details.');
    }
  });

  return { syncFromRecord, ensureScript };
}
