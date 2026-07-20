import { FORMAT_FLOW } from '../constants/formats.js';
import { EditorCaretManager } from '../handlers/EditorCaretManager.js';

export class KeyboardEditController {
    constructor (options = {}) {
        this.pageManager = options.pageManager;
        this.contentManager = options.contentManager;
    }

    destroy () {}

    handleEnter (currentLine) {
        if (!currentLine) return;
        const currentFormat = currentLine.getAttribute('data-format') || 'action';
        const nextFormat = FORMAT_FLOW[currentFormat] || 'action';

        const newLine = this.pageManager.createLine(nextFormat, '');
        
        if (currentLine.nextSibling) {
            currentLine.parentNode.insertBefore(newLine, currentLine.nextSibling);
        } else {
            currentLine.parentNode.appendChild(newLine);
        }

        EditorCaretManager.setCaretPosition(newLine, 0);
        
        if (this.contentManager && typeof this.contentManager.emit === 'function') {
            this.contentManager.emit('editor:content-changed', {});
        }
    }
}
