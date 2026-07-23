import { EditorCaretManager } from '../handlers/EditorCaretManager.js';

export class KeyboardSelectionController {
    constructor (options = {}) {
        this.pageManager = options.pageManager;
        this.editorArea = null;
    }

    setEditorArea (area) {
        this.editorArea = area;
    }

    destroy () {}

    /**
     * Move caret to adjacent script line. Returns the target line, or null.
     */
    navigateLine (currentLine, direction = 'next') {
        if (!currentLine) return null;
        const root = this.pageManager?.container || document;
        const allLines = Array.from(root.querySelectorAll('.script-line'));
        const idx = allLines.indexOf(currentLine);
        if (idx === -1) return null;

        const targetIdx = direction === 'next' ? idx + 1 : idx - 1;
        if (targetIdx < 0 || targetIdx >= allLines.length) return null;

        const targetLine = allLines[targetIdx];
        EditorCaretManager.setCaretPosition(targetLine, 0);
        return targetLine;
    }
}
