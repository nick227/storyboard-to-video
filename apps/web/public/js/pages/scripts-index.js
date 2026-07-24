import { fetchCategories, fetchPublicScripts } from '../scripts/api.js';
import { api } from '../core/api.js';
import { renderBreadcrumbs, renderCategoryNav, scriptCoverCard, escapeHtml } from '../scripts/chrome.js';
import { authorSlugFromSession, libraryHomePath, workPath, slugifyName } from '../core/app-paths.js';

const params = new URLSearchParams(window.location.search);
const tab = params.get('tab') === 'community' ? 'community' : 'mine';
const artifactFilter = ['screenplays', 'storyboards', 'timelines'].includes(params.get('artifact'))
  ? params.get('artifact')
  : 'all';

const breadcrumbs = document.getElementById('scriptsBreadcrumbs');
const scopeNav = document.getElementById('libraryScopeNav');
const artifactNav = document.getElementById('libraryArtifactNav');
const grid = document.getElementById('scriptsGrid');
const status = document.getElementById('scriptsStatus');
const categoryNav = document.getElementById('categoryNav');
const newBtn = document.getElementById('libraryNewBtn');

breadcrumbs.innerHTML = renderBreadcrumbs([{ label: 'Library' }]);

function scopeLink(id, label, active) {
  const href = id === 'mine' ? libraryHomePath('mine') : libraryHomePath('community');
  return `<a class="script-chip${active ? ' is-active' : ''}" href="${href}">${label}</a>`;
}

function artifactLink(id, label, active) {
  const url = new URL(window.location.href);
  if (id === 'all') url.searchParams.delete('artifact');
  else url.searchParams.set('artifact', id);
  if (tab === 'community') url.searchParams.set('tab', 'community');
  else url.searchParams.delete('tab');
  return `<a class="script-chip${active ? ' is-active' : ''}" href="${url.pathname}${url.search}">${label}</a>`;
}

scopeNav.innerHTML = [
  scopeLink('mine', 'Mine', tab === 'mine'),
  scopeLink('community', 'Community', tab === 'community'),
].join('');

artifactNav.innerHTML = [
  artifactLink('all', 'All', artifactFilter === 'all'),
  artifactLink('screenplays', 'Screenplays', artifactFilter === 'screenplays'),
  artifactLink('storyboards', 'Storyboards', artifactFilter === 'storyboards'),
  artifactLink('timelines', 'Timelines', artifactFilter === 'timelines'),
].join('');

function mineCard(project, session) {
  const slug = project.script?.slug || slugifyName(project.title);
  const author = project.script?.writer?.profileSlug || authorSlugFromSession(session) || 'anonymous';
  const artifact = artifactFilter === 'storyboards' ? 'storyboard'
    : artifactFilter === 'timelines' ? 'timeline'
      : 'screenplay';
  const editHref = workPath(author, slug, artifact, { edit: true });
  const viewHref = project.script?.visibility === 'public'
    ? workPath(author, slug, artifact)
    : '';
  return `<article class="script-cover-card library-mine-card">
    <p class="cover-label">${escapeHtml(artifact)}</p>
    <h2 class="cover-title">${escapeHtml(project.title || 'Untitled')}</h2>
    <p class="cover-meta">${project.script?.visibility === 'public' ? 'Public' : 'Private'}</p>
    <div class="library-card-actions">
      <a class="script-chip is-active" href="${escapeHtml(editHref)}">Edit</a>
      ${viewHref ? `<a class="script-chip" href="${escapeHtml(viewHref)}">View</a>` : ''}
    </div>
  </article>`;
}

try {
  const sessionRes = await fetch('/api/auth/session');
  const sessionData = await sessionRes.json();
  const session = sessionData.authenticated ? sessionData.session : null;

  if (tab === 'mine') {
    if (categoryNav) categoryNav.hidden = true;
    if (newBtn) newBtn.hidden = false;
    if (!session) {
      status.dataset.tone = 'empty';
      status.innerHTML = `Sign in to see your works. <a href="/login.html?redirect=${encodeURIComponent('/library')}">Sign in</a>`;
    } else {
      const { projects } = await api('/api/projects');
      let list = projects || [];
      // Artifact filters are navigational for edit targets; all works still list until per-artifact publish exists
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
    const [scripts, categories] = await Promise.all([fetchPublicScripts(), fetchCategories()]);
    if (categoryNav) {
      categoryNav.hidden = false;
      categoryNav.innerHTML = renderCategoryNav(categories);
    }
    if (!scripts.length) {
      status.dataset.tone = 'empty';
      status.textContent = 'No public screenplays yet.';
    } else {
      status.hidden = true;
      grid.hidden = false;
      grid.innerHTML = scripts.map((script) => scriptCoverCard(script)).join('');
    }
  }
} catch (error) {
  status.dataset.tone = 'error';
  status.textContent = error.message || 'Failed to load library.';
}
