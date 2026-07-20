import { VALID_FORMATS } from '../constants/formats.js';
import { ScriptDocument } from '../model/ScriptDocument.js';
import { ScriptLine } from '../model/ScriptLine.js';

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

            // 1. Scene Header detection
            if (/^(INT\.|EXT\.|INT\/EXT\.|I\/E\.|EST\.)/i.test(trimmed) || trimmed.startsWith('.')) {
                format = VALID_FORMATS.HEADER;
            }
            // 2. Directions / Parenthetical detection
            else if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
                format = VALID_FORMATS.DIRECTIONS;
            }
            // 3. Speaker detection (ALL CAPS, no lowercase, preceded by empty line/action/header)
            else if (
                trimmed === trimmed.toUpperCase() &&
                !/[a-z]/.test(trimmed) &&
                trimmed.length < 40 &&
                (prevFormat === null || prevFormat === VALID_FORMATS.HEADER || prevFormat === VALID_FORMATS.ACTION)
            ) {
                format = VALID_FORMATS.SPEAKER;
            }
            // 4. Dialog detection (Follows Speaker or Directions)
            else if (prevFormat === VALID_FORMATS.SPEAKER || prevFormat === VALID_FORMATS.DIRECTIONS) {
                format = VALID_FORMATS.DIALOG;
            }

            scriptLines.push(new ScriptLine({
                id: ScriptDocument.createLineId(),
                format,
                content: trimmed
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
            const content = line.content ? line.content.trim() : '';

            if ((line.format === VALID_FORMATS.HEADER || line.format === VALID_FORMATS.SPEAKER || line.format === VALID_FORMATS.ACTION) && prevFormat !== null) {
                fountainLines.push('');
            }

            fountainLines.push(content);
            prevFormat = line.format;
        }

        return fountainLines.join('\n');
    }
}
