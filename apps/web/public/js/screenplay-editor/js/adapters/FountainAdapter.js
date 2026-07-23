import { VALID_FORMATS } from '../constants/formats.js';
import { ScriptDocument } from '../model/ScriptDocument.js';
import { ScriptLine } from '../model/ScriptLine.js';

const TRANSITION_RE = /^(FADE (IN|OUT|TO BLACK)|CUT TO|DISSOLVE TO|SMASH CUT TO|MATCH CUT TO|WIPE TO|IRIS (IN|OUT)|TO BLACK)[:.]?$/i;

function isTransitionLine (trimmed) {
    if (TRANSITION_RE.test(trimmed)) return true;
    return trimmed === trimmed.toUpperCase()
        && !/[a-z]/.test(trimmed)
        && / TO:$/.test(trimmed)
        && trimmed.length < 40;
}

export class FountainAdapter {
    /**
     * Convert Fountain plain text into a ScriptDocument model
     * @param {string} fountainText
     * @returns {ScriptDocument}
     */
    static toDocument (fountainText = '') {
        if (!fountainText || typeof fountainText !== 'string') {
            return new ScriptDocument([]);
        }

        const lines = fountainText.split(/\r?\n/);
        const scriptLines = [];
        let prevFormat = null;

        for (let i = 0; i < lines.length; i++) {
            const rawLine = lines[i];
            const trimmed = rawLine.trim();

            if (trimmed === '') {
                prevFormat = null;
                continue;
            }

            let format = VALID_FORMATS.ACTION;
            let content = trimmed;

            if (trimmed.startsWith('@')) {
                format = VALID_FORMATS.SPEAKER;
                content = trimmed.slice(1).trim();
            } else if (/^(INT\.|EXT\.|INT\/EXT\.|I\/E\.|EST\.)/i.test(trimmed) || trimmed.startsWith('.')) {
                format = VALID_FORMATS.HEADER;
                if (trimmed.startsWith('.')) {
                    content = trimmed.slice(1).trim();
                }
            } else if (trimmed.startsWith('>') || isTransitionLine(trimmed)) {
                format = VALID_FORMATS.TRANSITION;
                content = trimmed.startsWith('>') ? trimmed.slice(1).trim() : trimmed;
            } else if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
                format = VALID_FORMATS.DIRECTIONS;
                content = trimmed.slice(1, -1).trim();
            } else if (
                trimmed === trimmed.toUpperCase() &&
                !/[a-z]/.test(trimmed) &&
                trimmed.length < 40 &&
                (prevFormat === null || prevFormat === VALID_FORMATS.HEADER || prevFormat === VALID_FORMATS.ACTION)
            ) {
                format = VALID_FORMATS.SPEAKER;
            } else if (prevFormat === VALID_FORMATS.SPEAKER || prevFormat === VALID_FORMATS.DIRECTIONS) {
                format = VALID_FORMATS.DIALOG;
            }

            scriptLines.push(new ScriptLine({
                id: ScriptDocument.createLineId(),
                format,
                content
            }));

            prevFormat = format;
        }

        return new ScriptDocument(scriptLines);
    }

    /**
     * Convert a ScriptDocument into clean Fountain formatted plain text
     * @param {ScriptDocument} document
     * @returns {string}
     */
    static toFountain (document) {
        if (!document || !Array.isArray(document.lines)) {
            return '';
        }

        const fountainLines = [];
        let prevFormat = null;

        for (const line of document.lines) {
            let content = line.content ? line.content.trim() : '';

            if ((line.format === VALID_FORMATS.HEADER || line.format === VALID_FORMATS.SPEAKER || line.format === VALID_FORMATS.ACTION || line.format === VALID_FORMATS.TRANSITION) && prevFormat !== null) {
                fountainLines.push('');
            }

            if (line.format === VALID_FORMATS.HEADER) {
                if (!/^(INT\.|EXT\.|INT\/EXT\.|I\/E\.|EST\.)/i.test(content) && !content.startsWith('.')) {
                    content = `.${content}`;
                }
            } else if (line.format === VALID_FORMATS.SPEAKER) {
                if ((/[a-z]/.test(content) || content !== content.toUpperCase()) && !content.startsWith('@')) {
                    content = `@${content}`;
                }
            } else if (line.format === VALID_FORMATS.DIRECTIONS) {
                if (!content.startsWith('(') || !content.endsWith(')')) {
                    content = `(${content})`;
                }
            } else if (line.format === VALID_FORMATS.TRANSITION) {
                if (!isTransitionLine(content) && !content.startsWith('>')) {
                    content = `>${content}`;
                }
            }

            fountainLines.push(content);
            prevFormat = line.format;
        }

        return fountainLines.join('\n');
    }
}
