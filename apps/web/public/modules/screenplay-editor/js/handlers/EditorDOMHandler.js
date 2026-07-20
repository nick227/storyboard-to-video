import { EditorCaretManager } from './EditorCaretManager.js';

export class EditorDOMHandler {
    constructor (options = {}) {
        this.pageManager = options.pageManager;
        this.lineFormatter = options.lineFormatter;
    }

    focusLine (lineElement, offset = 0) {
        if (!lineElement) return;
        EditorCaretManager.setCaretPosition(lineElement, offset);
    }

    getCaretPosition (lineElement) {
        return EditorCaretManager.getCaretPosition(lineElement);
    }
}
