import { fetchPublicScripts, scriptCoverCard } from './scripts-public-api.js';

const grid = document.getElementById('scriptsGrid');
const status = document.getElementById('scriptsStatus');

try {
  const scripts = await fetchPublicScripts();
  if (!scripts.length) {
    status.textContent = 'No public scripts yet.';
  } else {
    status.hidden = true;
    grid.hidden = false;
    grid.innerHTML = scripts.map(scriptCoverCard).join('');
  }
} catch (error) {
  status.dataset.tone = 'error';
  status.textContent = error.message || 'Failed to load scripts.';
}
