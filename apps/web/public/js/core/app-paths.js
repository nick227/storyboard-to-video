/** Work / artifact URL helpers. Work = author+slug; artifacts are first-class. */

export const ARTIFACTS = ['screenplay', 'storyboard', 'timeline'];
export const DEFAULT_ARTIFACT = 'screenplay';

/** Studio panel page ids ↔ URL artifacts */
export const ARTIFACT_TO_PAGE = {
  screenplay: 'script',
  storyboard: 'storyboard',
  timeline: 'timeline',
};
export const PAGE_TO_ARTIFACT = {
  script: 'screenplay',
  storyboard: 'storyboard',
  timeline: 'timeline',
};

const RESERVED = new Set([
  'library', 'login', 'admin', 'credits', 'writers', 'scripts', 'studio', 'script',
  'storyboard', 'timeline', 'screenplay', 'api', 'js', 'css', 'images', 'explore',
  'test', 'dev', 'favicon.ico', 'text-to-speech', 'projects', 'style-references',
]);

export function slugifyName(value = '') {
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'untitled';
}

export function isArtifact(value) {
  return ARTIFACTS.includes(value);
}

export function libraryHomePath(tab = '') {
  if (tab === 'community') return '/library?tab=community';
  if (tab === 'mine') return '/library?tab=mine';
  return '/library';
}

export function libraryCategoryPath(slug) {
  return `/library/category/${encodeURIComponent(slug)}`;
}

export function libraryTagPath(slug) {
  return `/library/tag/${encodeURIComponent(slug)}`;
}

export function parseLibraryBrowsePath(pathname = '') {
  const parts = String(pathname).split('/').filter(Boolean);
  if (parts[0] !== 'library') return null;
  if (parts[1] !== 'category' && parts[1] !== 'tag') return null;
  return { mode: parts[1], slug: decodeURIComponent(parts[2] || '') };
}

export function workPath(authorSlug, workSlug, artifact = DEFAULT_ARTIFACT, { edit = false } = {}) {
  const author = encodeURIComponent(authorSlug || 'anonymous');
  const slug = encodeURIComponent(workSlug || 'untitled');
  const art = isArtifact(artifact) ? artifact : DEFAULT_ARTIFACT;
  const base = `/${author}/${slug}/${art}`;
  return edit ? `${base}/edit` : base;
}

export function parseWorkPath(pathname = '') {
  const parts = String(pathname).replace(/\.html$/, '').split('/').filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  const [authorSlug, workSlug, artifact, editToken] = parts;
  if (RESERVED.has(authorSlug) || !isArtifact(artifact)) return null;
  if (parts.length === 4 && editToken !== 'edit') return null;
  return {
    authorSlug: decodeURIComponent(authorSlug),
    workSlug: decodeURIComponent(workSlug),
    artifact,
    edit: parts.length === 4,
    page: ARTIFACT_TO_PAGE[artifact],
  };
}

/** @deprecated use parseWorkPath — kept for gradual migration */
export function parseStudioPath(pathname = '') {
  const work = parseWorkPath(pathname);
  if (work) return { page: work.page, scriptSlug: work.workSlug, authorSlug: work.authorSlug, edit: work.edit, artifact: work.artifact };
  const legacy = String(pathname).replace(/\.html$/, '').match(/^\/(script|storyboard|timeline)(?:\/([^/]+))?\/?$/);
  if (!legacy) return null;
  return {
    page: legacy[1],
    scriptSlug: legacy[2] ? decodeURIComponent(legacy[2]) : null,
    authorSlug: null,
    edit: true,
    artifact: PAGE_TO_ARTIFACT[legacy[1]],
  };
}

export function scriptSlugFromRecord(record) {
  if (!record) return '';
  return record.script?.slug || slugifyName(record.title);
}

export function authorSlugFromSession(session) {
  return session?.user?.profileSlug || slugifyName(session?.user?.displayName) || 'anonymous';
}

export function authorSlugFromRecord(record, session) {
  return record?.script?.writer?.profileSlug
    || authorSlugFromSession(session)
    || 'anonymous';
}
