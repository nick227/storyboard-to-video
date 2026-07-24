import { fetchCategories, fetchPublicScripts, fetchTags } from '../scripts/api.js';
import { api } from '../core/api.js';
import { renderBreadcrumbs, renderFilterNav, scriptCoverCard, escapeHtml } from '../scripts/chrome.js';
import { authorSlugFromSession, libraryQueryPath, workPath, scriptSlugFromRecord } from '../core/app-paths.js';

const params = new URLSearchParams(window.location.search);
const tab = ['mine', 'community'].includes(params.get('tab')) ? params.get('tab') : 'all';
const artifactFilter = ['screenplays', 'storyboards', 'timelines'].includes(params.get('artifact'))
  ? params.get('artifact')
  : 'all';
const categoryFilter = (params.get('category') || '').trim();
const tagFilter = (params.get('tag') || '').trim();

const ARTIFACT_FROM_FILTER = {
  screenplays: 'screenplay',
  storyboards: 'storyboard',
  timelines: 'timeline',
};

const breadcrumbs = document.getElementById('scriptsBreadcrumbs');
const scopeNav = document.getElementById('libraryScopeNav');
const artifactNav = document.getElementById('libraryArtifactNav');
const grid = document.getElementById('scriptsGrid');
const status = document.getElementById('scriptsStatus');
const categoryNav = document.getElementById('categoryNav');
const tagNav = document.getElementById('tagNav');
const newBtn = document.getElementById('libraryNewBtn');

breadcrumbs.innerHTML = renderBreadcrumbs([{ label: 'Library' }]);

function libraryHref(overrides = {}) {
  return libraryQueryPath({
    tab,
    artifact: artifactFilter,
    category: categoryFilter,
    tag: tagFilter,
    ...overrides,
  });
}

function scopeLink(id, label, active) {
  return `<a class="script-chip${active ? ' is-active' : ''}" href="${libraryHref({
    tab: id,
    category: id === 'mine' ? '' : categoryFilter,
    tag: id === 'mine' ? '' : tagFilter,
  })}">${label}</a>`;
}

function artifactLink(id, label, active) {
  return `<a class="script-chip${active ? ' is-active' : ''}" href="${libraryHref({ artifact: id })}">${label}</a>`;
}

scopeNav.innerHTML = [
  scopeLink('all', 'All', tab === 'all'),
  scopeLink('mine', 'Mine', tab === 'mine'),
  scopeLink('community', 'Community', tab === 'community'),
].join('');

artifactNav.innerHTML = [
  artifactLink('all', 'All', artifactFilter === 'all'),
  artifactLink('screenplays', 'Screenplays', artifactFilter === 'screenplays'),
  artifactLink('storyboards', 'Storyboards', artifactFilter === 'storyboards'),
  artifactLink('timelines', 'Timelines', artifactFilter === 'timelines'),
].join('');

function selectedArtifact() {
  return ARTIFACT_FROM_FILTER[artifactFilter] || null;
}

function artifactState(script, artifact) {
  return script?.artifacts?.[artifact]
    || (artifact === 'screenplay'
      ? { visibility: script?.visibility || 'private', publishedAt: script?.publishedAt || null }
      : { visibility: 'private', publishedAt: null });
}

function mineCard(project, session) {
  const slug = scriptSlugFromRecord(project);
  const author = project.script?.writer?.profileSlug || authorSlugFromSession(session) || 'anonymous';
  const artifact = selectedArtifact() || 'screenplay';
  const state = artifactState(project.script, artifact);
  const isPublic = state.visibility === 'public';
  const editUrl = new URL(workPath(author, slug, artifact, { edit: true }), window.location.origin);
  editUrl.searchParams.set('project', project.id);
  const editHref = `${editUrl.pathname}${editUrl.search}`;
  const viewHref = isPublic ? workPath(author, slug, artifact) : '';
  return `<article class="script-cover-card library-mine-card">
    <p class="cover-label">${escapeHtml(artifact)}</p>
    <h2 class="cover-title">${escapeHtml(project.title || 'Untitled')}</h2>
    <p class="cover-meta">${isPublic ? 'Public' : 'Private'}</p>
    <div class="library-card-actions">
      <a class="script-chip is-active" href="${escapeHtml(editHref)}">Edit</a>
      ${viewHref ? `<a class="script-chip" href="${escapeHtml(viewHref)}">View</a>` : ''}
    </div>
  </article>`;
}

function renderPublicGrid(scripts) {
  if (!scripts.length) {
    const emptyLabel = artifactFilter === 'all' ? 'works' : artifactFilter;
    status.dataset.tone = 'empty';
    status.hidden = false;
    grid.hidden = true;
    status.textContent = `No public ${emptyLabel} yet.`;
    return;
  }
  status.hidden = true;
  grid.hidden = false;
  grid.innerHTML = scripts.map((script) => scriptCoverCard(script, {
    artifact: script.artifact || selectedArtifact() || 'screenplay',
  })).join('');
}

function renderFilterBars(categories, tags) {
  if (categoryNav) {
    categoryNav.hidden = false;
    categoryNav.innerHTML = renderFilterNav(categories, {
      ariaLabel: 'Categories',
      activeSlug: categoryFilter,
      allHref: libraryHref({ category: '' }),
      hrefFor: (item) => libraryHref({ category: item.slug }),
    });
  }
  if (tagNav) {
    tagNav.hidden = false;
    tagNav.innerHTML = renderFilterNav(tags, {
      ariaLabel: 'Tags',
      activeSlug: tagFilter,
      allHref: libraryHref({ tag: '' }),
      hrefFor: (item) => libraryHref({ tag: item.slug }),
    });
  }
}

try {
  const sessionRes = await fetch('/api/auth/session');
  const sessionData = await sessionRes.json();
  const session = sessionData.authenticated ? sessionData.session : null;

  if (tab === 'mine') {
    if (categoryNav) categoryNav.hidden = true;
    if (tagNav) tagNav.hidden = true;
    if (newBtn) newBtn.hidden = false;
    if (!session) {
      status.dataset.tone = 'empty';
      status.innerHTML = `Sign in to see your works. <a href="/login.html?redirect=${encodeURIComponent('/library?tab=mine')}">Sign in</a>`;
    } else {
      const { projects } = await api('/api/projects');
      const list = projects || [];
      if (!list.length) {
        status.dataset.tone = 'empty';
        status.textContent = 'No works yet. Create a screenplay to get started.';
      } else {
        status.hidden = true;
        grid.hidden = false;
        grid.innerHTML = list.map((project) => mineCard(project, session)).join('');
      }
    }
    if (newBtn) {
      newBtn.addEventListener('click', () => {
        const author = authorSlugFromSession(session) || 'anonymous';
        window.location.href = workPath(author, 'untitled', 'screenplay', { edit: true });
      });
    }
  } else {
    if (newBtn) newBtn.hidden = true;
    const artifact = selectedArtifact() || 'all';
    const [scripts, categories, tags] = await Promise.all([
      fetchPublicScripts({ artifact, category: categoryFilter, tag: tagFilter }),
      fetchCategories(),
      fetchTags(),
    ]);
    renderFilterBars(categories, tags);

    let feed = scripts;
    if (tab === 'community' && session?.user?.id) {
      feed = scripts.filter((script) => script.writer?.id !== session.user.id);
    }
    renderPublicGrid(feed);
  }
} catch (error) {
  status.dataset.tone = 'error';
  status.textContent = error.message || 'Failed to load library.';
}
