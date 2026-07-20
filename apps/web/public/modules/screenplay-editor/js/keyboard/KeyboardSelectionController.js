import { EditorCaretManager } from '../handlers/EditorCaretManager.js';

export class KeyboardSelectionController {
    constructor (options = {}) {
        this.pageManager = options.pageManager;
    }

    setEditorArea (area) {
        this.editorArea = area;
    }

    destroy () {}

    navigateLine (currentLine, direction = 'next') {
        if (!currentLine) return;
        const allLines = Array.from(document.querySelectorAll('.script-line'));
        const idx = allLines.indexOf(currentLine);
        if (idx === -1) return;

        const targetIdx = direction === 'next' ? idx + 1 : idx - 1;
        if (targetIdx >= 0 && targetIdx < allLines.length) {
            const targetLine = allLines[targetIdx];
            EditorCaretManager.setCaretPosition(targetLine, 0);
        }
    }
}
