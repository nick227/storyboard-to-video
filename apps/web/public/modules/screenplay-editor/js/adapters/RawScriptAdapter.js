import { FountainAdapter } from './FountainAdapter.js';
import { ScriptDocument } from '../model/ScriptDocument.js';
import { ScriptLine } from '../model/ScriptLine.js';
import { DEFAULT_FORMAT, isValidFormat } from '../constants/formats.js';

export class RawScriptAdapter {
    static parse (input, format = 'fountain') {
        if (!input) {
            return new ScriptDocument([]);
        }

        switch (format.toLowerCase()) {
            case 'fountain':
                return FountainAdapter.toDocument(typeof input === 'string' ? input : '');

            case 'tagged':
                return ScriptDocument.fromStorage(typeof input === 'string' ? input : '');

            case 'json': {
                try {
                    const parsed = typeof input === 'string' ? JSON.parse(input) : input;
                    return RawScriptAdapter.fromArray(Array.isArray(parsed) ? parsed : parsed.lines);
                } catch {
                    return new ScriptDocument([]);
                }
            }

            case 'array':
                return RawScriptAdapter.fromArray(Array.isArray(input) ? input : []);

            default:
                return FountainAdapter.toDocument(String(input));
        }
    }

    static fromArray (array = []) {
        if (!Array.isArray(array)) return new ScriptDocument([]);
        const lines = array.map(item => new ScriptLine({
            id: item.id || ScriptDocument.createLineId(),
            format: isValidFormat(item.format) ? item.format : DEFAULT_FORMAT,
            content: item.content || item.text || ''
        }));
        return new ScriptDocument(lines);
    }

    static serialize (document, format = 'fountain') {
        if (!document) return '';

        switch (format.toLowerCase()) {
            case 'fountain':
                return FountainAdapter.toFountain(document);

            case 'tagged':
                return document.toStorage();

            case 'json':
                return JSON.stringify(document.lines.map(l => ({ format: l.format, content: l.content })));

            case 'array':
                return document.lines.map(l => ({ id: l.id, format: l.format, content: l.content }));

            default:
                return FountainAdapter.toFountain(document);
        }
    }
}
