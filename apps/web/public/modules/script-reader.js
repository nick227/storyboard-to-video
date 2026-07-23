import { RawScriptAdapter } from './screenplay-editor/js/adapters/RawScriptAdapter.js';
import { fetchPublicScript, toggleScriptLike } from './scripts/api.js';
import {
  bindFullscreen, bindShareButton, escapeHtml, renderBreadcrumbs,
  scriptCoverCard, scriptCoverPage,
} from './scripts/chrome.js';

function renderBody(scriptText = '') {
  return RawScriptAdapter.parse(scriptText, 'fountain').lines.map((line) => (
    `<p class="${escapeHtml(line.format)}">${escapeHtml(line.content.trim())}</p>`
  )).join('\n');
}

function loginRedirect() {
  const target = `/login.html?redirect=${encodeURIComponent(window.location.pathname)}`;
  window.location.href = target;
}

const slug = decodeURIComponent(window.location.pathname.replace(/^\/scripts\//, '').replace(/\/$/, ''));
const status = document.getElementById('readerStatus');
const article = document.getElementById('readerArticle');
const stage = document.getElementById('readerStage');
const likeBtn = document.getElementById('scriptLikeBtn');
const likeCount = document.getElementById('scriptLikeCount');
const shareBtn = document.getElementById('scriptShareBtn');
const fullscreenBtn = document.getElementById('scriptFullscreenBtn');
const authorBox = document.getElementById('authorBox');
const authorGrid = document.getElementById('authorGrid');
const authorHeading = document.getElementById('authorHeading');
const breadcrumbs = document.getElementById('scriptsBreadcrumbs');
const toolbarStatus = document.getElementById('readerToolbarStatus');

bindFullscreen(fullscreenBtn, stage);

try {
  const script = await fetchPublicScript(slug);
  document.title = `${script.title || 'Script'} — Storyboarder`;
  breadcrumbs.innerHTML = renderBreadcrumbs([
    { label: 'Scripts', href: '/scripts' },
    { label: script.title || 'Untitled' },
  ]);

  document.getElementById('readerCover').innerHTML = scriptCoverPage(script);
  document.getElementById('readerBody').innerHTML = renderBody(script.scriptText || '');

  likeCount.textContent = String(script.likeCount || 0);
  likeBtn.setAttribute('aria-pressed', String(Boolean(script.likedByMe)));
  likeBtn.classList.toggle('is-liked', Boolean(script.likedByMe));

  const shareUrl = new URL(`/scripts/${script.slug}`, window.location.origin).toString();
  bindShareButton(shareBtn, {
    getUrl: shareUrl,
    title: script.title || 'Screenplay',
    text: `Written by ${script.author || 'Anonymous'}`,
    onStatus: (message) => { toolbarStatus.textContent = message; },
  });

  likeBtn.addEventListener('click', async () => {
    try {
      const result = await toggleScriptLike(script.id);
      likeBtn.setAttribute('aria-pressed', String(result.liked));
      likeBtn.classList.toggle('is-liked', result.liked);
      likeCount.textContent = String(result.likeCount || 0);
    } catch (error) {
      if (error.status === 401 || error.code === 'UNAUTHENTICATED') return loginRedirect();
      toolbarStatus.textContent = error.message || 'Could not update like.';
    }
  });

  const others = script.moreByAuthor || [];
  if (others.length) {
    authorHeading.textContent = `More by ${script.author || 'this author'}`;
    authorGrid.innerHTML = others.map((item) => scriptCoverCard(item, { compact: true })).join('');
    authorBox.hidden = false;
  }

  status.hidden = true;
  article.hidden = false;
} catch (error) {
  status.dataset.tone = 'error';
  status.textContent = error.code === 'SCRIPT_NOT_FOUND' ? 'Script not found.' : (error.message || 'Failed to load script.');
}
