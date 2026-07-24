import { RawScriptAdapter } from '../screenplay-editor/js/adapters/RawScriptAdapter.js';
import { ViewportScaler } from '../screenplay-editor/js/ui/ViewportScaler.js';
import { fetchPublicScript, toggleScriptLike } from '../scripts/api.js';
import { renderStoryboardView, renderTimelineView } from '../scripts/artifact-viewer.js';
import {
  bindFullscreen, bindShareButton, escapeHtml, flashStatus, loginRedirect,
  renderBreadcrumbs, scriptCoverCard, scriptCoverPage, scriptTrail,
} from '../scripts/chrome.js';
import { parseWorkPath, workPath } from '../core/app-paths.js';
import { initWorkbar } from '../shared/workbar.js';

function renderLines(scriptText = '') {
  return RawScriptAdapter.parse(scriptText, 'fountain').lines.map((line) => (
    `<div class="script-line" data-format="${escapeHtml(line.format)}">${escapeHtml(line.content.trim())}</div>`
  )).join('\n');
}

function showArtifactChrome({ cover, body, artifactRoot, storyboard, timeline, toolbar }, mode) {
  const isBoard = mode === 'storyboard';
  const isTimeline = mode === 'timeline';
  const isScript = mode === 'screenplay';
  cover.hidden = !isScript;
  body.hidden = !isScript;
  artifactRoot.hidden = isScript;
  storyboard.hidden = !isBoard;
  timeline.hidden = !isTimeline;
  toolbar.hidden = !isScript;
  if (!isScript) cover.replaceChildren();
}

const route = parseWorkPath(window.location.pathname);
const slug = route?.workSlug || '';
const authorSlug = route?.authorSlug || '';
const artifact = route?.artifact || 'screenplay';
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
const readerBody = document.getElementById('readerBody');
const readerWorkspace = document.getElementById('readerWorkspace');
const readerScaleShell = document.getElementById('readerScaleShell');
const readerScaleTarget = document.getElementById('readerScaleTarget');
const readerPage = document.getElementById('readerPage');
const artifactView = document.getElementById('artifactView');
const storyboardView = document.getElementById('storyboardView');
const timelineView = document.getElementById('timelineView');
const readerCover = document.getElementById('readerCover');
const readerToolbar = document.querySelector('.script-reader-toolbar');
const chrome = {
  cover: readerCover,
  body: readerBody,
  artifactRoot: artifactView,
  storyboard: storyboardView,
  timeline: timelineView,
  toolbar: readerToolbar,
};

initWorkbar();

try {
  if (!route) throw Object.assign(new Error('Not found'), { code: 'SCRIPT_NOT_FOUND' });

  const script = await fetchPublicScript(slug, { artifact });
  const canonicalAuthor = script.writer?.profileSlug || 'anonymous';
  if (canonicalAuthor !== authorSlug || script.slug !== slug) {
    window.location.replace(workPath(canonicalAuthor, script.slug, artifact));
  }

  const label = artifact === 'storyboard' ? 'Storyboard'
    : artifact === 'timeline' ? 'Timeline'
      : 'Screenplay';
  document.title = `${script.title || label} — Storyboarder`;
  breadcrumbs.innerHTML = renderBreadcrumbs([
    ...scriptTrail(script).slice(0, -1),
    { label },
    { label: script.title || 'Untitled' },
  ]);

  const scenes = script.project?.scenes || [];
  showArtifactChrome(chrome, artifact);

  if (artifact === 'storyboard') {
    renderStoryboardView(storyboardView, scenes);
  } else if (artifact === 'timeline') {
    await renderTimelineView(timelineView, scenes);
  } else {
    bindFullscreen(fullscreenBtn, stage);
    readerCover.innerHTML = scriptCoverPage(script);
    readerPage.innerHTML = renderLines(script.scriptText || '');

    const scaler = new ViewportScaler({
      wrapper: readerBody,
      workspace: readerWorkspace,
      shell: readerScaleShell,
      target: readerScaleTarget,
    });
    scaler.start();
    scaler.scheduleUpdate();

    likeCount.textContent = String(script.likeCount || 0);
    likeBtn.setAttribute('aria-pressed', String(Boolean(script.likedByMe)));
    likeBtn.classList.toggle('is-liked', Boolean(script.likedByMe));

    likeBtn.addEventListener('click', async () => {
      try {
        const result = await toggleScriptLike(script.id);
        likeBtn.setAttribute('aria-pressed', String(result.liked));
        likeBtn.classList.toggle('is-liked', result.liked);
        likeCount.textContent = String(result.likeCount || 0);
        flashStatus(toolbarStatus, result.liked ? 'Liked' : 'Like removed');
      } catch (error) {
        if (error.status === 401 || error.code === 'UNAUTHENTICATED') return loginRedirect();
        flashStatus(toolbarStatus, error.message || 'Could not update like');
      }
    });

    bindShareButton(shareBtn, {
      getUrl: new URL(workPath(canonicalAuthor, script.slug, artifact), window.location.origin).toString(),
      title: script.title || label,
      text: script.logline || `By ${script.author || 'Anonymous'}`,
      onStatus: (message) => flashStatus(toolbarStatus, message),
    });
  }

  const others = script.moreByAuthor || [];
  if (others.length) {
    const writerLink = script.writer?.profileSlug
      ? ` <a href="/writers/${encodeURIComponent(script.writer.profileSlug)}">View profile</a>`
      : '';
    authorHeading.innerHTML = `More by ${escapeHtml(script.author || 'this author')}${writerLink}`;
    authorGrid.innerHTML = others.map((item) => scriptCoverCard(item, { compact: true, artifact })).join('');
    authorBox.hidden = false;
  }

  status.hidden = true;
  article.hidden = false;
} catch (error) {
  status.dataset.tone = 'error';
  status.textContent = error.code === 'SCRIPT_NOT_FOUND' || error.code === 'NOT_FOUND'
    ? `${artifact === 'screenplay' ? 'Screenplay' : artifact} not found.`
    : (error.message || 'Failed to load.');
}
