import {
  ARTIFACTS, authorSlugFromRecord, parseWorkPath, scriptSlugFromRecord, workPath,
} from '../core/app-paths.js';
import { projectStore } from '../core/store.js';

const RECENT_KEY = 'storyboarder.recentWorks';
const RECENT_LIMIT = 8;

function readRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch (_) { return []; }
}

function pushRecent(entry) {
  if (!entry?.authorSlug || !entry?.workSlug) return;
  const next = [
    entry,
    ...readRecent().filter((item) => !(item.authorSlug === entry.authorSlug && item.workSlug === entry.workSlug)),
  ].slice(0, RECENT_LIMIT);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch (_) {}
}

/**
 * @param {{
 *   session?: object,
 *   getRecord?: () => object|null,
 *   onOpenWork?: (projectId: string) => void,
 *   shareUrl?: string|(() => string),
 *   onShareStatus?: (message: string) => void,
 * }} [options]
 */
export function initWorkbar(options = {}) {
  const root = document.querySelector('.sf-workbar');
  if (!root) return null;

  const route = parseWorkPath(window.location.pathname);
  if (!route) {
    root.hidden = true;
    return null;
  }

  root.hidden = false;
  const titleBtn = document.getElementById('workTitleBtn');
  const titleLabel = document.getElementById('workTitleLabel');
  const recentList = document.getElementById('workRecentList');
  const shareBtn = document.getElementById('workShareBtn');
  const downloadBtn = document.getElementById('downloadZipBtn');
  const tabs = Array.from(root.querySelectorAll('.sf-artifact-tab'));

  const sync = () => {
    const record = options.getRecord?.() || null;
    const authorSlug = route.authorSlug || authorSlugFromRecord(record, options.session);
    const workSlug = route.workSlug || scriptSlugFromRecord(record) || 'untitled';
    const title = record?.title || workSlug;
    titleLabel.textContent = title;

    pushRecent({
      authorSlug,
      workSlug,
      title,
      projectId: record?.id || null,
      artifact: route.artifact,
    });

    for (const tab of tabs) {
      const artifact = tab.dataset.artifact;
      const active = artifact === route.artifact;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-current', active ? 'page' : 'false');
      tab.href = workPath(authorSlug, workSlug, artifact, { edit: route.edit });
    }

    if (downloadBtn) {
      if (route.edit) {
        downloadBtn.hidden = false;
        const url = new URL(workPath(authorSlug, workSlug, route.artifact, { edit: true }), window.location.origin);
        url.searchParams.set('download', '1');
        downloadBtn.href = `${url.pathname}${url.search}`;
      } else {
        downloadBtn.hidden = true;
      }
    }
  };

  const closeRecent = () => {
    recentList.hidden = true;
    titleBtn.setAttribute('aria-expanded', 'false');
  };

  const openRecent = () => {
    const items = readRecent();
    recentList.innerHTML = items.map((item) => (
      `<li role="option" data-author="${item.authorSlug}" data-slug="${item.workSlug}" data-project="${item.projectId || ''}">
        <button type="button">${item.title || item.workSlug}</button>
      </li>`
    )).join('') || '<li class="sf-work-recent-empty">No recent works</li>';
    recentList.hidden = false;
    titleBtn.setAttribute('aria-expanded', 'true');
  };

  titleBtn.addEventListener('click', () => {
    if (recentList.hidden) openRecent();
    else closeRecent();
  });

  recentList.addEventListener('click', (event) => {
    const option = event.target.closest('[data-slug]');
    if (!option) return;
    closeRecent();
    const projectId = option.dataset.project;
    if (projectId && options.onOpenWork) {
      options.onOpenWork(projectId);
      return;
    }
    const artifact = route.artifact || 'screenplay';
    window.location.href = workPath(option.dataset.author, option.dataset.slug, artifact, { edit: route.edit });
  });

  document.addEventListener('click', (event) => {
    if (!recentList.hidden && !root.contains(event.target)) closeRecent();
  });

  shareBtn?.addEventListener('click', async () => {
    const raw = typeof options.shareUrl === 'function' ? options.shareUrl() : options.shareUrl;
    const url = raw || new URL(workPath(route.authorSlug, route.workSlug, route.artifact), window.location.origin).toString();
    try {
      if (navigator.share) {
        await navigator.share({ title: titleLabel.textContent, url });
        options.onShareStatus?.('Shared');
      } else {
        await navigator.clipboard.writeText(url);
        options.onShareStatus?.('Link copied');
      }
    } catch (error) {
      if (error?.name === 'AbortError') return;
      options.onShareStatus?.(error.message || 'Could not share');
    }
  });

  sync();
  projectStore.subscribe?.(sync);

  return {
    sync,
    route,
    artifacts: ARTIFACTS,
  };
}
