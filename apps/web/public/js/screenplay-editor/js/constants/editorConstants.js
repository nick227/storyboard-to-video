/**
 * Centralized editor constants for standalone ScreenplayEditor
 */
export const EDITOR_EVENTS = Object.freeze({
    CONTENT_CHANGED: 'editor:content-changed',
    SELECTION_CHANGED: 'editor:selection-changed',
    FORMAT_CHANGED: 'editor:format-changed',
    LINE_INSERTED: 'editor:line-inserted',
    LINE_DELETED: 'editor:line-deleted',
    PAGE_CHANGED: 'editor:page-changed'
});

export const MAX_LINES_PER_PAGE = 54;
