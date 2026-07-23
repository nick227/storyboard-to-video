import { DEFAULT_FORMAT, isValidFormat } from '../constants/formats.js';
import { ScriptLine } from './ScriptLine.js';

export class ScriptDocument {
    /**
     * @param {ScriptLine[]} lines
     */
    constructor (lines = []) {
        this.lines = Array.isArray(lines) ? lines : [];
    }

    static createLineId () {
        return `line_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    }

    static fromStorage (content = '') {
        if (typeof content !== 'string' || !content.trim()) {
            return new ScriptDocument([]);
        }

        const rawLines = content.split(/\r?\n/);
        const lines = rawLines.map(line => {
            const parsed = ScriptDocument._parseTaggedLine(line);
            return new ScriptLine({
                id: ScriptDocument.createLineId(),
                format: parsed.format,
                content: parsed.content
            });
        });
        return new ScriptDocument(lines);
    }

    static _parseTaggedLine (line) {
        if (!line) return { format: DEFAULT_FORMAT, content: '' };
        const match = line.match(/<([\w-]+)>([\s\S]*)<\/\1>/);
        if (match) {
            const format = match[1].toLowerCase();
            return {
                format: isValidFormat(format) ? format : DEFAULT_FORMAT,
                content: match[2]
            };
        }
        return { format: DEFAULT_FORMAT, content: line };
    }

    toStorage () {
        return this.lines.map(l => `<${l.format}>${l.content}</${l.format}>`).join('\n');
    }
}
