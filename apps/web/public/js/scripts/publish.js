import { api } from '../core/api.js';
import { ensureProjectSynced, getCurrentStoryboardRecord, saveStoryboard } from '../core/persistence.js';
import { shareUrl } from './chrome.js';
import { fetchCategories, fetchScriptStats, updateScriptMeta } from './api.js';
import { parseWorkPath, workPath } from '../core/app-paths.js';

function parseTagSlugs(value = '') {
  return [...new Set(String(value).split(/[,#]+/).map((part) => part.trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean))].slice(0, 8);
}

function activeArtifact() {
  if (typeof window === 'undefined') return 'screenplay';
  return parseWorkPath(window.location.pathname)?.artifact || 'screenplay';
}

function artifactVisibility(script, artifact = 'screenplay') {
  return script?.artifacts?.[artifact]?.visibility
    || (artifact === 'screenplay' ? script?.visibility : null)
    || 'private';
}

function artifactSharePath(script, artifact = 'screenplay') {
  if (!script?.slug) return '';
  return script?.sharePaths?.[artifact]
    || workPath(script.writer?.profileSlug || 'anonymous', script.slug, artifact);
}

export function initScriptPublishControls(elements, { setStatus, getArtifact = activeArtifact } = {}) {
  const toggles = [elements.scriptVisibilityToggle, elements.workVisibilityToggle].filter(Boolean);
  const shareBtns = [elements.scriptShareBtn, elements.workShareBtn].filter(Boolean);
  if (!toggles.length && !shareBtns.length) return { syncFromRecord() {} };

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
    const artifact = getArtifact();
    const isPublic = artifactVisibility(script, artifact) === 'public';
    const path = artifactSharePath(script, artifact);
    for (const toggle of toggles) {
      toggle.checked = isPublic;
    }
    for (const shareBtn of shareBtns) {
      shareBtn.disabled = !isPublic || !script?.slug;
      shareBtn.dataset.sharePath = path;
      shareBtn.dataset.artifact = artifact;
    }
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
      throw new Error('Save the work before publishing.');
    }
    const scriptId = fresh.script?.id || fresh.scriptId;
    const response = await api(`/api/scripts/${encodeURIComponent(scriptId)}`);
    applyScript(response.script);
    return response.script;
  }

  function closeMetaModal() {
    elements.scriptMetaModal?.close();
  }

  async function openMetaModal() {
    if (!elements.scriptMetaModal) return;
    await syncFromRecord();
    elements.scriptMetaModal.showModal();
  }

  async function onVisibilityChange(sourceToggle) {
    if (busy) return;
    const record = getCurrentStoryboardRecord();
    if (!record) {
      sourceToggle.checked = false;
      return;
    }
    const artifact = getArtifact();
    const desiredVisibility = sourceToggle.checked ? 'public' : 'private';
    busy = true;
    for (const toggle of toggles) toggle.disabled = true;
    try {
      const script = await ensureScript(record);
      for (const toggle of toggles) toggle.checked = desiredVisibility === 'public';
      const response = await api(`/api/scripts/${encodeURIComponent(script.id)}/visibility`, {
        method: 'POST',
        body: JSON.stringify({ visibility: desiredVisibility, artifact }),
      });
      applyScript(response.script);
      const label = artifact.charAt(0).toUpperCase() + artifact.slice(1);
      setStatus?.(desiredVisibility === 'public' ? `${label} is public.` : `${label} is private.`);
    } catch (error) {
      applyScript(getCurrentStoryboardRecord()?.script || null);
      setStatus?.(error.message || 'Could not update visibility.');
    } finally {
      for (const toggle of toggles) toggle.disabled = false;
      busy = false;
    }
  }

  for (const toggle of toggles) {
    toggle.addEventListener('change', () => onVisibilityChange(toggle));
  }

  async function onShareClick(shareBtn) {
    const path = shareBtn.dataset.sharePath;
    if (!path) return;
    const url = new URL(path, window.location.origin).toString();
    const artifact = shareBtn.dataset.artifact || getArtifact();
    try {
      const result = await shareUrl(url, { title: getCurrentStoryboardRecord()?.title || artifact });
      setStatus?.(result === 'shared' ? 'Shared.' : 'Share link copied.');
    } catch (error) {
      if (error?.name === 'AbortError') return;
      setStatus?.(error.message || url);
    }
  }

  for (const shareBtn of shareBtns) {
    shareBtn.addEventListener('click', () => { onShareClick(shareBtn); });
  }

  elements.scriptMetaBtn?.addEventListener('click', () => {
    openMetaModal().catch((error) => setStatus?.(error.message || 'Could not open publishing details.'));
  });
  elements.scriptMetaCloseBtn?.addEventListener('click', closeMetaModal);
  elements.scriptMetaCancelBtn?.addEventListener('click', closeMetaModal);
  elements.scriptMetaModal?.addEventListener('click', (event) => {
    if (event.target === elements.scriptMetaModal) closeMetaModal();
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

  return { syncFromRecord, ensureScript, applyScript };
}
