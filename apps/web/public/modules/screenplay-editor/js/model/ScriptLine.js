/**
 * Represents a single line element in a screenplay document.
 */
export class ScriptLine {
    /**
     * @param {object} options
     * @param {string} options.id
     * @param {string} options.format
     * @param {string} options.content
     */
    constructor ({ id, format, content }) {
        this.id = id;
        this.format = format;
        this.content = content || '';
    }
}
