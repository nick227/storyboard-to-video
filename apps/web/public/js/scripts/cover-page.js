import { updateScriptMeta } from './api.js';
import { getCurrentStoryboardRecord } from '../core/persistence.js';
import { formatPublishedDate } from './chrome.js';

const SUMMARY_MAX = 4000;
const SAVE_DEBOUNCE_MS = 600;

function coverArtInnerHtml(coverUrl) {
  if (!coverUrl) return '';
  const safeUrl = String(coverUrl).replaceAll('"', '&quot;');
  return `<img src="${safeUrl}" alt="" />`;
}

export function initStudioCoverPage(elements, {
  ensureScript,
  applyScript,
  setStatus,
  getTitle,
  getAuthor,
} = {}) {
  const root = elements.scriptCoverPage;
  if (!root) return { syncFromRecord() {}, getSummary: () => '', getCoverMeta: () => ({}) };

  const art = elements.scriptCoverPageArt;
  const titleEl = elements.scriptCoverPageTitle;
  const authorEl = elements.scriptCoverPageAuthor;
  const dateEl = elements.scriptCoverPageDate;
  const summaryEl = elements.scriptCoverPageSummary;
  const hintEl = elements.scriptCoverPageSummaryHint;

  let saveTimer = 0;
  let lastSavedSummary = '';

  function updateHint() {
    if (!hintEl || !summaryEl) return;
    const length = summaryEl.value.length;
    hintEl.textContent = `${length} / ${SUMMARY_MAX}`;
  }

  function syncCoverArt(coverUrl = null) {
    root.classList.toggle('has-cover-art', Boolean(coverUrl));
    if (!art) return;
    if (coverUrl) {
      art.innerHTML = coverArtInnerHtml(coverUrl);
      art.hidden = false;
    } else {
      art.innerHTML = '';
      art.hidden = true;
    }
  }

  function syncDate(script, record) {
    if (!dateEl) return;
    const date = formatPublishedDate(script?.publishedAt || script?.updatedAt || record?.updatedAt);
    if (date) {
      dateEl.textContent = date;
      dateEl.hidden = false;
    } else {
      dateEl.textContent = '';
      dateEl.hidden = true;
    }
  }

  function syncFromRecord(record = getCurrentStoryboardRecord()) {
    const script = record?.script || null;
    const title = (typeof getTitle === 'function' ? getTitle() : null)
      || record?.title
      || script?.title
      || 'Untitled';
    const author = (typeof getAuthor === 'function' ? getAuthor() : null)
      || script?.author
      || 'Anonymous';
    if (titleEl) titleEl.textContent = title;
    if (authorEl) authorEl.textContent = author;
    syncDate(script, record);
    const summary = script?.summary || '';
    if (summaryEl && document.activeElement !== summaryEl) {
      summaryEl.value = summary;
      lastSavedSummary = summary;
      updateHint();
    }
    syncCoverArt(script?.coverUrl || null);
  }

  async function persistSummary() {
    if (!summaryEl) return;
    const summary = summaryEl.value.slice(0, SUMMARY_MAX);
    if (summary === lastSavedSummary) return;
    try {
      const script = await ensureScript?.();
      if (!script?.id) return;
      const response = await updateScriptMeta(script.id, { summary });
      lastSavedSummary = summary;
      applyScript?.(response.script);
    } catch (error) {
      setStatus?.(error.message || 'Could not save summary.');
    }
  }

  function queueSummarySave() {
    updateHint();
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      persistSummary().catch(() => {});
    }, SAVE_DEBOUNCE_MS);
  }

  summaryEl?.addEventListener('input', queueSummarySave);
  summaryEl?.addEventListener('change', () => {
    clearTimeout(saveTimer);
    persistSummary().catch(() => {});
  });

  syncFromRecord();

  return {
    syncFromRecord,
    getSummary: () => (summaryEl?.value || '').slice(0, SUMMARY_MAX),
    getCoverMeta: () => {
      const script = getCurrentStoryboardRecord()?.script || null;
      return {
        title: titleEl?.textContent || 'Untitled',
        author: authorEl?.textContent || 'Anonymous',
        summary: (summaryEl?.value || script?.summary || '').slice(0, SUMMARY_MAX),
        coverUrl: script?.coverUrl || null,
      };
    },
    scrollIntoView: () => {
      root.scrollIntoView({ block: 'start', behavior: 'auto' });
    },
  };
}
