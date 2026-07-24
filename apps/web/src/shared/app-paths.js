'use strict';

const STUDIO_PAGES = ['script', 'storyboard', 'timeline'];
const DEFAULT_STUDIO_PAGE = 'storyboard';

function isStudioPath(pathname = '') {
  const path = String(pathname).split('?')[0];
  return path === '/studio'
    || path === '/studio.html'
    || /^\/(script|storyboard|timeline)(\/[^/]+)?$/.test(path);
}

function studioPath(page = DEFAULT_STUDIO_PAGE, scriptSlug = '') {
  const base = `/${STUDIO_PAGES.includes(page) ? page : DEFAULT_STUDIO_PAGE}`;
  return scriptSlug ? `${base}/${encodeURIComponent(scriptSlug)}` : base;
}

function studioRedirectTarget(req) {
  const page = STUDIO_PAGES.includes(req.query.page) ? req.query.page : DEFAULT_STUDIO_PAGE;
  const suffix = req.query.download ? '?download=1' : '';
  return `${studioPath(page)}${suffix}`;
}

function libraryHomePath() {
  return '/library';
}

function libraryCategoryPath(slug) {
  return `/library/category/${encodeURIComponent(slug)}`;
}

function libraryTagPath(slug) {
  return `/library/tag/${encodeURIComponent(slug)}`;
}

function libraryScriptPath(authorSlug, scriptSlug) {
  return `/library/${encodeURIComponent(authorSlug || 'anonymous')}/${encodeURIComponent(scriptSlug)}`;
}

function sharePathFor(script) {
  if (!script?.slug) return '';
  return libraryScriptPath(script.writer?.profileSlug || 'anonymous', script.slug);
}

module.exports = {
  STUDIO_PAGES,
  DEFAULT_STUDIO_PAGE,
  isStudioPath,
  studioPath,
  studioRedirectTarget,
  libraryHomePath,
  libraryCategoryPath,
  libraryTagPath,
  libraryScriptPath,
  sharePathFor,
};
