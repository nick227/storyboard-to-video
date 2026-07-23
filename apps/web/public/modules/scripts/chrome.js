export function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function formatPublishedDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/** @param {{ label: string, href?: string }[]} crumbs */
export function renderBreadcrumbs(crumbs = []) {
  if (!crumbs.length) return '';
  const items = crumbs.map((crumb, index) => {
    const last = index === crumbs.length - 1;
    if (last || !crumb.href) {
      return `<li${last ? ' aria-current="page"' : ''}><span>${escapeHtml(crumb.label)}</span></li>`;
    }
    return `<li><a href="${escapeHtml(crumb.href)}">${escapeHtml(crumb.label)}</a></li>`;
  }).join('<li aria-hidden="true" class="scripts-breadcrumb-sep">/</li>');
  return `<nav class="scripts-breadcrumbs" aria-label="Breadcrumb"><ol>${items}</ol></nav>`;
}

export function scriptCoverCard(script, { compact = false } = {}) {
  const classes = compact ? 'script-cover-card is-compact' : 'script-cover-card';
  const likes = Number(script.likeCount || 0);
  const meta = compact ? '' : `<p class="cover-meta">${likes ? `${likes} like${likes === 1 ? '' : 's'}` : 'New'}</p>`;
  return `<a class="${classes}" href="/scripts/${encodeURIComponent(script.slug)}">
    <p class="cover-label">Screenplay</p>
    <h2 class="cover-title">${escapeHtml(script.title || 'Untitled')}</h2>
    <p class="cover-author">${escapeHtml(script.author || 'Anonymous')}</p>
    ${meta}
  </a>`;
}

export function scriptCoverPage(script) {
  const date = formatPublishedDate(script.publishedAt);
  return `<header class="script-cover-page" aria-label="Screenplay cover">
    <div class="script-cover-page-top">
      <p class="script-cover-page-label">Screenplay</p>
    </div>
    <div class="script-cover-page-mid">
      <h1>${escapeHtml(script.title || 'Untitled')}</h1>
      <p class="script-cover-page-author">Written by<br><strong>${escapeHtml(script.author || 'Anonymous')}</strong></p>
    </div>
    <div class="script-cover-page-bottom">
      ${date ? `<p class="script-cover-page-date">${escapeHtml(date)}</p>` : ''}
    </div>
  </header>`;
}

export async function shareUrl(url, { title = 'Screenplay', text = '' } = {}) {
  if (navigator.share) {
    await navigator.share({ title, text, url });
    return 'shared';
  }
  await navigator.clipboard.writeText(url);
  return 'copied';
}

export function bindFullscreen(button, target) {
  if (!button || !target) return;
  const label = button.querySelector('[data-fullscreen-label]') || button;
  const sync = () => {
    const active = document.fullscreenElement === target;
    button.setAttribute('aria-pressed', String(active));
    label.textContent = active ? 'Exit' : 'Full screen';
  };
  button.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement === target) await document.exitFullscreen();
      else await target.requestFullscreen();
    } catch (_) {}
  });
  document.addEventListener('fullscreenchange', sync);
  sync();
}

export function bindShareButton(button, { getUrl, title, text, onStatus } = {}) {
  if (!button) return;
  button.addEventListener('click', async () => {
    const url = typeof getUrl === 'function' ? getUrl() : getUrl;
    if (!url) return;
    try {
      const result = await shareUrl(url, { title, text });
      onStatus?.(result === 'shared' ? 'Shared' : 'Link copied');
    } catch (error) {
      if (error?.name === 'AbortError') return;
      onStatus?.(error.message || 'Could not share');
    }
  });
}

export function flashStatus(el, message, ms = 2200) {
  if (!el) return;
  el.textContent = message || '';
  clearTimeout(el._scriptsStatusTimer);
  if (!message) return;
  el._scriptsStatusTimer = setTimeout(() => { el.textContent = ''; }, ms);
}
