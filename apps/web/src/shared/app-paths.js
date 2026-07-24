'use strict';

const ARTIFACTS = ['screenplay', 'storyboard', 'timeline'];
const DEFAULT_ARTIFACT = 'screenplay';
const PAGE_TO_ARTIFACT = { script: 'screenplay', storyboard: 'storyboard', timeline: 'timeline' };

const RESERVED = new Set([
  'library', 'login', 'admin', 'credits', 'writers', 'scripts', 'studio', 'script',
  'storyboard', 'timeline', 'screenplay', 'api', 'js', 'css', 'images', 'explore',
  'test', 'dev', 'text-to-speech', 'projects', 'style-references',
]);

function isArtifact(value) {
  return ARTIFACTS.includes(value);
}

function workPath(authorSlug, workSlug, artifact = DEFAULT_ARTIFACT, { edit = false } = {}) {
  const author = encodeURIComponent(authorSlug || 'anonymous');
  const slug = encodeURIComponent(workSlug || 'untitled');
  const art = isArtifact(artifact) ? artifact : DEFAULT_ARTIFACT;
  const base = `/${author}/${slug}/${art}`;
  return edit ? `${base}/edit` : base;
}

function parseWorkPath(pathname = '') {
  const parts = String(pathname).split('?')[0].split('/').filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  const [authorSlug, workSlug, artifact, editToken] = parts;
  if (RESERVED.has(authorSlug) || !isArtifact(artifact)) return null;
  if (parts.length === 4 && editToken !== 'edit') return null;
  return {
    authorSlug: decodeURIComponent(authorSlug),
    workSlug: decodeURIComponent(workSlug),
    artifact,
    edit: parts.length === 4,
  };
}

function isEditPath(pathname = '') {
  const parsed = parseWorkPath(pathname);
  return Boolean(parsed?.edit);
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

function sharePathFor(script) {
  if (!script?.slug) return '';
  return workPath(script.writer?.profileSlug || 'anonymous', script.slug, 'screenplay');
}

function legacyStudioRedirect(req) {
  const page = req.query.page;
  const artifact = PAGE_TO_ARTIFACT[page] || DEFAULT_ARTIFACT;
  const q = req.query.download ? '?download=1' : '';
  // Bare studio entry → library; entity-less artifact edit isn't addressable yet
  if (!req.params?.slug) return `${libraryHomePath()}${q}`;
  return workPath('anonymous', req.params.slug, artifact, { edit: true }) + q;
}

module.exports = {
  ARTIFACTS,
  DEFAULT_ARTIFACT,
  RESERVED,
  isArtifact,
  workPath,
  parseWorkPath,
  isEditPath,
  libraryHomePath,
  libraryCategoryPath,
  libraryTagPath,
  sharePathFor,
  legacyStudioRedirect,
};
