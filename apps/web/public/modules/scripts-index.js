import { fetchPublicScripts } from './scripts/api.js';
import { renderBreadcrumbs, scriptCoverCard } from './scripts/chrome.js';

document.getElementById('scriptsBreadcrumbs').innerHTML = renderBreadcrumbs([
  { label: 'Scripts' },
]);

const grid = document.getElementById('scriptsGrid');
const status = document.getElementById('scriptsStatus');

try {
  const scripts = await fetchPublicScripts();
  if (!scripts.length) {
    status.textContent = 'No public scripts yet.';
  } else {
    status.hidden = true;
    grid.hidden = false;
    grid.innerHTML = scripts.map((script) => scriptCoverCard(script)).join('');
  }
} catch (error) {
  status.dataset.tone = 'error';
  status.textContent = error.message || 'Failed to load scripts.';
}
