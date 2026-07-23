import { fetchCategories, fetchPublicScripts } from './scripts/api.js';
import { renderBreadcrumbs, renderCategoryNav, scriptCoverCard } from './scripts/chrome.js';

document.getElementById('scriptsBreadcrumbs').innerHTML = renderBreadcrumbs([
  { label: 'Scripts' },
]);

const grid = document.getElementById('scriptsGrid');
const status = document.getElementById('scriptsStatus');
const categoryNav = document.getElementById('categoryNav');

try {
  const [scripts, categories] = await Promise.all([fetchPublicScripts(), fetchCategories()]);
  if (categoryNav) categoryNav.innerHTML = renderCategoryNav(categories);
  if (!scripts.length) {
    status.dataset.tone = 'empty';
    status.textContent = 'No public screenplays yet. Publish one from Studio to appear here.';
  } else {
    status.hidden = true;
    grid.hidden = false;
    grid.innerHTML = scripts.map((script) => scriptCoverCard(script)).join('');
  }
} catch (error) {
  status.dataset.tone = 'error';
  status.textContent = error.message || 'Failed to load scripts.';
}
