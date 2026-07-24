/** Shared path helpers for studio + public library URLs. */

export const STUDIO_PAGES = ['script', 'storyboard', 'timeline'];
export const DEFAULT_STUDIO_PAGE = 'storyboard';

export function slugifyName(value = '') {
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'untitled';
}

export function studioPath(page = DEFAULT_STUDIO_PAGE, scriptSlug = '') {
  const base = `/${STUDIO_PAGES.includes(page) ? page : DEFAULT_STUDIO_PAGE}`;
  return scriptSlug ? `${base}/${encodeURIComponent(scriptSlug)}` : base;
}

export function parseStudioPath(pathname = '') {
  const match = String(pathname).replace(/\.html$/, '').match(/^\/(script|storyboard|timeline)(?:\/([^/]+))?\/?$/);
  if (!match) return null;
  return {
    page: match[1],
    scriptSlug: match[2] ? decodeURIComponent(match[2]) : null,
  };
}

export function libraryHomePath() {
  return '/library';
}

export function libraryCategoryPath(slug) {
  return `/library/category/${encodeURIComponent(slug)}`;
}

export function libraryTagPath(slug) {
  return `/library/tag/${encodeURIComponent(slug)}`;
}

export function libraryScriptPath(authorSlug, scriptSlug) {
  return `/library/${encodeURIComponent(authorSlug || 'anonymous')}/${encodeURIComponent(scriptSlug)}`;
}

export function parseLibraryScriptPath(pathname = '') {
  const parts = String(pathname).split('/').filter(Boolean);
  if (parts[0] !== 'library' || parts.length < 3) return null;
  if (parts[1] === 'category' || parts[1] === 'tag') return null;
  return {
    authorSlug: decodeURIComponent(parts[1]),
    scriptSlug: decodeURIComponent(parts[2]),
  };
}

export function parseLibraryBrowsePath(pathname = '') {
  const parts = String(pathname).split('/').filter(Boolean);
  if (parts[0] !== 'library') return null;
  if (parts[1] !== 'category' && parts[1] !== 'tag') return null;
  return { mode: parts[1], slug: decodeURIComponent(parts[2] || '') };
}

export function scriptSlugFromRecord(record) {
  if (!record) return '';
  return record.script?.slug || slugifyName(record.title);
}
