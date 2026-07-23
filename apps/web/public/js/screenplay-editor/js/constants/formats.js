/**
 * Semantic screenplay element types (separate from CSS layout rules).
 */
export const VALID_FORMATS = Object.freeze({
    HEADER: 'header',
    ACTION: 'action',
    SPEAKER: 'speaker',
    DIALOG: 'dialog',
    DIRECTIONS: 'directions',
    TRANSITION: 'transition',
    CHAPTER_BREAK: 'chapter-break'
});

export const VALID_FORMAT_VALUES = Object.freeze(Object.values(VALID_FORMATS));
export const DEFAULT_FORMAT = VALID_FORMATS.ACTION;

export const FORMAT_DISPLAY_NAMES = Object.freeze({
    [VALID_FORMATS.HEADER]: 'Scene Heading',
    [VALID_FORMATS.ACTION]: 'Action',
    [VALID_FORMATS.SPEAKER]: 'Character',
    [VALID_FORMATS.DIALOG]: 'Dialogue',
    [VALID_FORMATS.DIRECTIONS]: 'Parenthetical',
    [VALID_FORMATS.TRANSITION]: 'Transition',
    [VALID_FORMATS.CHAPTER_BREAK]: 'Chapter Break'
});

export function isValidFormat (format) {
    return VALID_FORMAT_VALUES.includes(format);
}

export function getFormatDisplayName (format) {
    return FORMAT_DISPLAY_NAMES[format] || format;
}

export const FORMAT_FLOW = Object.freeze({
    [VALID_FORMATS.HEADER]: VALID_FORMATS.ACTION,
    [VALID_FORMATS.ACTION]: VALID_FORMATS.SPEAKER,
    [VALID_FORMATS.SPEAKER]: VALID_FORMATS.DIALOG,
    [VALID_FORMATS.DIALOG]: VALID_FORMATS.SPEAKER,
    [VALID_FORMATS.DIRECTIONS]: VALID_FORMATS.DIALOG,
    [VALID_FORMATS.TRANSITION]: VALID_FORMATS.HEADER,
    [VALID_FORMATS.CHAPTER_BREAK]: VALID_FORMATS.HEADER
});

export const FORMAT_CYCLE = Object.freeze([
    VALID_FORMATS.HEADER,
    VALID_FORMATS.ACTION,
    VALID_FORMATS.SPEAKER,
    VALID_FORMATS.DIALOG,
    VALID_FORMATS.DIRECTIONS,
    VALID_FORMATS.TRANSITION
]);

export function getNextFormat (currentFormat, direction = 1) {
    const cycle = FORMAT_CYCLE;
    const idx = cycle.indexOf(currentFormat);
    if (idx === -1) return DEFAULT_FORMAT;
    const nextIdx = (idx + direction + cycle.length) % cycle.length;
    return cycle[nextIdx];
}
