import { fetchCategories, fetchPublicScripts, fetchTags } from '../scripts/api.js';
import { api } from '../core/api.js';
import { renderBreadcrumbs, renderFilterNav, scriptCoverCard, escapeHtml } from '../scripts/chrome.js';
import { authorSlugFromSession, libraryQueryPath, workPath, scriptSlugFromRecord } from '../core/app-paths.js';

const params = new URLSearchParams(window.location.search);
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
const artifactNav = document.getElementById('libraryArtifactNav');
const grid = document.getElementById('scriptsGrid');
const status = document.getElementById('scriptsStatus');
const categoryNav = document.getElementById('categoryNav');
const tagNav = document.getElementById('tagNav');
const newBtn = document.getElementById('libraryNewBtn');

breadcrumbs.innerHTML = renderBreadcrumbs([{ label: 'Library' }]);

function libraryHref(overrides = {}) {
  return libraryQueryPath({
    artifact: artifactFilter,
    category: categoryFilter,
    tag: tagFilter,
    ...overrides,
  });
}

function artifactLink(id, label, active) {
  return `<a class="script-chip${active ? ' is-active' : ''}" href="${libraryHref({ artifact: id })}">${label}</a>`;
}

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

function renderFilterBars(categories, tags) {
  if (categoryNav) {
    const html = renderFilterNav(categories, {
      ariaLabel: 'Categories',
      activeSlug: categoryFilter,
      allHref: libraryHref({ category: '' }),
      hrefFor: (item) => libraryHref({ category: item.slug }),
    });
    categoryNav.innerHTML = html;
    categoryNav.hidden = !html;
  }
  if (tagNav) {
    const html = renderFilterNav(tags, {
      ariaLabel: 'Tags',
      activeSlug: tagFilter,
      allHref: libraryHref({ tag: '' }),
      hrefFor: (item) => libraryHref({ tag: item.slug }),
    });
    tagNav.innerHTML = html;
    tagNav.hidden = !html;
  }
}

function bindNewScreenplay(session) {
  if (!newBtn) return;
  newBtn.hidden = false;
  newBtn.addEventListener('click', async () => {
    if (!session) {
      window.location.href = `/login.html?redirect=${encodeURIComponent('/library')}`;
      return;
    }
    newBtn.disabled = true;
    try {
      // Create first, then open by project id. A bare /untitled/edit URL is ambiguous and
      // restores the previous work (or any existing untitled slug) instead of a blank draft.
      const { project } = await api('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ title: 'Untitled' }),
      });
      const author = authorSlugFromSession(session) || 'anonymous';
      const url = new URL(workPath(author, 'untitled', 'screenplay', { edit: true }), window.location.origin);
      url.searchParams.set('project', project.id);
      window.location.href = `${url.pathname}${url.search}`;
    } catch (error) {
      newBtn.disabled = false;
      status.dataset.tone = 'error';
      status.hidden = false;
      status.textContent = error.message || 'Failed to create screenplay.';
    }
  });
}

function excludeOwnedPublicScripts(scripts, projects, session) {
  const ownedIds = new Set(
    projects.map((project) => project.scriptId || project.script?.id).filter(Boolean),
  );
  const userId = session?.user?.id;
  return scripts.filter((script) => {
    if (script.id && ownedIds.has(script.id)) return false;
    if (userId && script.writer?.id === userId) return false;
    return true;
  });
}

try {
  const sessionRes = await fetch('/api/auth/session');
  const sessionData = await sessionRes.json();
  const session = sessionData.authenticated ? sessionData.session : null;
  bindNewScreenplay(session);

  const artifact = selectedArtifact() || 'all';
  const [scripts, categories, tags, projectsPayload] = await Promise.all([
    fetchPublicScripts({ artifact, category: categoryFilter, tag: tagFilter }),
    fetchCategories(),
    fetchTags(),
    session ? api('/api/projects') : Promise.resolve({ projects: [] }),
  ]);
  renderFilterBars(categories, tags);

  const projects = projectsPayload.projects || [];
  const publicScripts = excludeOwnedPublicScripts(scripts, projects, session);
  const cards = [
    ...projects.map((project) => mineCard(project, session)),
    ...publicScripts.map((script) => scriptCoverCard(script, {
      artifact: script.artifact || selectedArtifact() || 'screenplay',
    })),
  ];

  if (!cards.length) {
    const emptyLabel = artifactFilter === 'all' ? 'works' : artifactFilter;
    status.dataset.tone = 'empty';
    status.hidden = false;
    grid.hidden = true;
    status.textContent = `No ${emptyLabel} yet.`;
  } else {
    status.hidden = true;
    grid.hidden = false;
    grid.innerHTML = cards.join('');
  }
} catch (error) {
  status.dataset.tone = 'error';
  status.textContent = error.message || 'Failed to load library.';
}
