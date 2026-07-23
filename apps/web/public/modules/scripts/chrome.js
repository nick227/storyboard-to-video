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

export function scriptTrail(script = {}) {
  const crumbs = [{ label: 'Scripts', href: '/scripts' }];
  if (script.category?.slug) {
    crumbs.push({ label: script.category.name, href: `/scripts/category/${script.category.slug}` });
  }
  const primaryTag = script.tags?.[0];
  if (primaryTag?.slug) {
    crumbs.push({ label: primaryTag.name, href: `/scripts/tag/${primaryTag.slug}` });
  }
  crumbs.push({ label: script.title || 'Untitled' });
  return crumbs;
}

export function scriptCoverCard(script, { compact = false } = {}) {
  const classes = compact ? 'script-cover-card is-compact' : 'script-cover-card';
  const likes = Number(script.likeCount || 0);
  const logline = !compact && script.logline
    ? `<p class="cover-logline">${escapeHtml(script.logline)}</p>`
    : '';
  const meta = compact ? '' : `<p class="cover-meta">${likes ? `${likes} like${likes === 1 ? '' : 's'}` : 'New'}</p>`;
  return `<a class="${classes}" href="/scripts/${encodeURIComponent(script.slug)}">
    <p class="cover-label">${escapeHtml(script.category?.name || 'Screenplay')}</p>
    <h2 class="cover-title">${escapeHtml(script.title || 'Untitled')}</h2>
    ${logline}
    <p class="cover-author">${escapeHtml(script.author || 'Anonymous')}</p>
    ${meta}
  </a>`;
}

export function scriptCoverPage(script) {
  const date = formatPublishedDate(script.publishedAt);
  const writerHref = script.writer?.profileSlug
    ? `/writers/${encodeURIComponent(script.writer.profileSlug)}`
    : '';
  const author = writerHref
    ? `<a class="script-cover-page-author-link" href="${writerHref}">${escapeHtml(script.author || 'Anonymous')}</a>`
    : escapeHtml(script.author || 'Anonymous');
  const logline = script.logline
    ? `<p class="script-cover-page-logline">${escapeHtml(script.logline)}</p>`
    : '';
  const tags = (script.tags || []).map((tag) => (
    `<a class="script-chip" href="/scripts/tag/${encodeURIComponent(tag.slug)}">${escapeHtml(tag.name)}</a>`
  )).join('');
  const category = script.category
    ? `<a class="script-chip" href="/scripts/category/${encodeURIComponent(script.category.slug)}">${escapeHtml(script.category.name)}</a>`
    : '';
  return `<header class="script-cover-page" aria-label="Screenplay cover">
    <div class="script-cover-page-top">
      <p class="script-cover-page-label">Screenplay</p>
      <div class="script-chip-row">${category}${tags}</div>
    </div>
    <div class="script-cover-page-mid">
      <h1>${escapeHtml(script.title || 'Untitled')}</h1>
      ${logline}
      <p class="script-cover-page-author">Written by<br><strong>${author}</strong></p>
    </div>
    <div class="script-cover-page-bottom">
      ${date ? `<p class="script-cover-page-date">${escapeHtml(date)}</p>` : ''}
    </div>
  </header>`;
}

export function renderCategoryNav(categories = [], activeSlug = '') {
  if (!categories.length) return '';
  const items = [
    `<a class="script-chip${!activeSlug ? ' is-active' : ''}" href="/scripts">All</a>`,
    ...categories.map((category) => (
      `<a class="script-chip${category.slug === activeSlug ? ' is-active' : ''}" href="/scripts/category/${encodeURIComponent(category.slug)}">${escapeHtml(category.name)}</a>`
    )),
  ];
  return `<nav class="script-category-nav" aria-label="Categories">${items.join('')}</nav>`;
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

export function loginRedirect() {
  window.location.href = `/login.html?redirect=${encodeURIComponent(window.location.pathname)}`;
}
