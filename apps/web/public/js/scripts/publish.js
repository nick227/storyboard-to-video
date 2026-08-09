import { api } from '../core/api.js';
import { ensureProjectSynced, getCurrentStoryboardRecord, saveStoryboard } from '../core/persistence.js';
import { shareUrl } from './chrome.js';
import { fetchCategories, fetchScriptStats, updateScriptMeta } from './api.js';
import { bindCoverArtControls, syncScreenplayLogos } from './cover-art.js';
import { parseWorkPath, workPath } from '../core/app-paths.js';

const SUMMARY_MAX = 4000;

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

function artifactLabel(artifact) {
  return artifact.charAt(0).toUpperCase() + artifact.slice(1);
}

export function initScriptPublishControls(elements, {
  setStatus,
  getArtifact = activeArtifact,
  openImageLibrary,
  getTitle,
  getAuthor,
} = {}) {
  const toggle = elements.workVisibilityToggle;
  const shareBtns = [elements.scriptShareBtn, elements.workShareBtn].filter(Boolean);
  if (!toggle && !shareBtns.length && !elements.scriptMetaBtn) return { syncFromRecord() {} };

  let busy = false;
  let categoriesLoaded = false;

  function updateSummaryHint() {
    const summaryEl = elements.scriptSummary;
    const hintEl = elements.scriptSummaryHint;
    if (!hintEl || !summaryEl) return;
    hintEl.textContent = `${summaryEl.value.length} / ${SUMMARY_MAX}`;
  }

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
    if (elements.scriptSummary && document.activeElement !== elements.scriptSummary) {
      elements.scriptSummary.value = script?.summary || '';
      updateSummaryHint();
    }
    if (elements.scriptCategorySelect) elements.scriptCategorySelect.value = script?.categoryId || script?.category?.id || '';
    if (elements.scriptTagsInput) {
      elements.scriptTagsInput.value = (script?.tags || []).map((tag) => tag.slug || tag.name).join(', ');
    }
    syncScreenplayLogos(script?.coverUrl || null);
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
    if (toggle) {
      toggle.checked = isPublic;
      toggle.dataset.artifact = artifact;
      const label = toggle.closest('label');
      if (label) label.title = `Make this ${artifact} publicly viewable`;
    }
    for (const shareBtn of shareBtns) {
      const shareArtifact = shareBtn === elements.scriptShareBtn ? 'screenplay' : artifact;
      shareBtn.disabled = artifactVisibility(script, shareArtifact) !== 'public' || !script?.slug;
      shareBtn.dataset.sharePath = artifactSharePath(script, shareArtifact);
      shareBtn.dataset.artifact = shareArtifact;
    }
    applyMetaFields(script);
    if (script?.id) refreshStats(script.id);
  }

  async function syncFromRecord(record = getCurrentStoryboardRecord()) {
    await ensureCategories().catch(() => {});
    applyScript(record?.script || null);
  }

  async function ensureScript(record) {
    const existingId = record?.script?.id || record?.scriptId;
    if (existingId) {
      const response = await api(`/api/scripts/${encodeURIComponent(existingId)}`);
      applyScript(response.script);
      return response.script;
    }
    saveStoryboard(elements, false);
    await ensureProjectSynced();
    const fresh = getCurrentStoryboardRecord();
    const scriptId = fresh?.script?.id || fresh?.scriptId;
    if (!scriptId) throw new Error('Save the work before publishing.');
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

  async function onVisibilityChange() {
    if (!toggle || busy) return;
    const record = getCurrentStoryboardRecord();
    if (!record) {
      toggle.checked = false;
      return;
    }
    const artifact = getArtifact();
    const desiredVisibility = toggle.checked ? 'public' : 'private';
    busy = true;
    toggle.disabled = true;
    try {
      const script = await ensureScript(record);
      toggle.checked = desiredVisibility === 'public';
      const response = await api(`/api/scripts/${encodeURIComponent(script.id)}/visibility`, {
        method: 'POST',
        body: JSON.stringify({ visibility: desiredVisibility, artifact }),
      });
      applyScript(response.script);
      setStatus?.(desiredVisibility === 'public'
        ? `${artifactLabel(artifact)} is public.`
        : `${artifactLabel(artifact)} is private.`);
    } catch (error) {
      applyScript(getCurrentStoryboardRecord()?.script || null);
      setStatus?.(error.message || 'Could not update visibility.');
    } finally {
      toggle.disabled = false;
      busy = false;
    }
  }

  toggle?.addEventListener('change', () => onVisibilityChange());

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
  elements.scriptSummary?.addEventListener('input', updateSummaryHint);

  elements.scriptMetaSaveBtn?.addEventListener('click', async () => {
    const record = getCurrentStoryboardRecord();
    if (!record) return;
    try {
      const script = await ensureScript(record);
      const response = await updateScriptMeta(script.id, {
        logline: elements.scriptLogline?.value || '',
        summary: (elements.scriptSummary?.value || '').slice(0, SUMMARY_MAX),
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

  bindCoverArtControls({
    triggers: [
      elements.screenplayCoverBtn,
      elements.scriptCoverBtn,
      elements.scriptCoverChangeBtn,
    ],
    removeBtn: elements.scriptCoverRemoveBtn,
    ensureScript: () => ensureScript(getCurrentStoryboardRecord()),
    applyScript,
    setStatus,
    openImageLibrary,
    closeMetaModal,
    getStyleId: () => elements.styleSelect?.value || '',
    domEls: elements,
  });

  function currentSummary() {
    if (elements.scriptSummary) return (elements.scriptSummary.value || '').slice(0, SUMMARY_MAX);
    return (getCurrentStoryboardRecord()?.script?.summary || '').slice(0, SUMMARY_MAX);
  }

  function getCoverMeta() {
    const script = getCurrentStoryboardRecord()?.script || null;
    const title = (typeof getTitle === 'function' ? getTitle() : null)
      || getCurrentStoryboardRecord()?.title
      || script?.title
      || 'Untitled';
    const author = (typeof getAuthor === 'function' ? getAuthor() : null)
      || script?.author
      || 'Anonymous';
    return {
      title,
      author,
      summary: currentSummary(),
      coverUrl: script?.coverUrl || null,
    };
  }

  applyMetaFields(getCurrentStoryboardRecord()?.script || null);

  return {
    syncFromRecord,
    ensureScript,
    applyScript,
    getSummary: currentSummary,
    getCoverMeta,
  };
}
