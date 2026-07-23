import {
  fetchCategories, fetchScriptsByCategory, fetchScriptsByTag,
} from './scripts/api.js';
import { renderBreadcrumbs, renderCategoryNav, scriptCoverCard } from './scripts/chrome.js';

const parts = window.location.pathname.split('/').filter(Boolean);
const mode = parts[1]; // category | tag
const slug = decodeURIComponent(parts[2] || '');

const breadcrumbs = document.getElementById('scriptsBreadcrumbs');
const status = document.getElementById('scriptsStatus');
const grid = document.getElementById('scriptsGrid');
const title = document.getElementById('browseTitle');
const subtitle = document.getElementById('browseSubtitle');
const kicker = document.getElementById('browseKicker');
const categoryNav = document.getElementById('categoryNav');

try {
  const categories = await fetchCategories();
  const scripts = mode === 'tag'
    ? await fetchScriptsByTag(slug)
    : await fetchScriptsByCategory(slug);

  const category = categories.find((item) => item.slug === slug);
  const label = mode === 'tag'
    ? (scripts[0]?.tags?.find((tag) => tag.slug === slug)?.name || slug)
    : (category?.name || slug);

  kicker.textContent = mode === 'tag' ? 'Tag' : 'Category';
  title.textContent = label;
  subtitle.textContent = mode === 'tag'
    ? `Public screenplays tagged ${label}.`
    : `Public ${label.toLowerCase()} screenplays.`;

  breadcrumbs.innerHTML = renderBreadcrumbs([
    { label: 'Scripts', href: '/scripts' },
    { label },
  ]);
  categoryNav.innerHTML = renderCategoryNav(categories, mode === 'category' ? slug : '');

  if (!scripts.length) {
    status.dataset.tone = 'empty';
    status.textContent = 'No public screenplays in this collection yet.';
  } else {
    status.hidden = true;
    grid.hidden = false;
    grid.innerHTML = scripts.map((script) => scriptCoverCard(script)).join('');
  }
} catch (error) {
  status.dataset.tone = 'error';
  status.textContent = error.message || 'Failed to load scripts.';
}
