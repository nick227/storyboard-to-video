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
        this._emitChange();
    }

    handleBackspace (currentLine) {
        if (!currentLine) return;
        const prevLine = this._getPreviousScriptLine(currentLine);

        if (!prevLine) {
            const nextLine = this._getNextScriptLine(currentLine);
            if (nextLine && (!currentLine.textContent || currentLine.textContent.trim() === '')) {
                currentLine.remove();
                EditorCaretManager.setCaretPosition(nextLine, 0);
                this._emitChange();
            }
            return;
        }

        const prevLen = prevLine.textContent ? prevLine.textContent.length : 0;
        const currentText = currentLine.textContent || '';

        prevLine.textContent = (prevLine.textContent || '') + currentText;
        currentLine.remove();

        EditorCaretManager.setCaretPosition(prevLine, prevLen);
        this._emitChange();
    }

    handleDelete (currentLine) {
        if (!currentLine) return;
        const nextLine = this._getNextScriptLine(currentLine);
        if (!nextLine) return;

        const currentLen = currentLine.textContent ? currentLine.textContent.length : 0;
        const nextText = nextLine.textContent || '';

        currentLine.textContent = (currentLine.textContent || '') + nextText;
        nextLine.remove();

        EditorCaretManager.setCaretPosition(currentLine, currentLen);
        this._emitChange();
    }

    handleMultiLineDelete (selection) {
        if (!selection || selection.isCollapsed) return;
        const range = selection.getRangeAt(0);

        let startLine = this._getContainingScriptLine(range.startContainer);
        let endLine = this._getContainingScriptLine(range.endContainer);

        if (!startLine || !endLine || startLine === endLine) return;

        const allLines = Array.from(document.querySelectorAll('.script-line'));
        const startIndex = allLines.indexOf(startLine);
        const endIndex = allLines.indexOf(endLine);

        if (startIndex === -1 || endIndex === -1) return;

        const minIdx = Math.min(startIndex, endIndex);
        const maxIdx = Math.max(startIndex, endIndex);

        const firstLine = allLines[minIdx];
        const lastLine = allLines[maxIdx];

        const firstKeepText = firstLine.textContent.slice(0, range.startOffset);
        const lastKeepText = lastLine.textContent.slice(range.endOffset);

        for (let i = minIdx + 1; i <= maxIdx; i++) {
            allLines[i].remove();
        }

        firstLine.textContent = firstKeepText + lastKeepText;
        EditorCaretManager.setCaretPosition(firstLine, firstKeepText.length);

        this._emitChange();
    }

    _getPreviousScriptLine (line) {
        const container = this.pageManager ? this.pageManager.container : document;
        const allLines = Array.from(container.querySelectorAll('.script-line'));
        const idx = allLines.indexOf(line);
        return idx > 0 ? allLines[idx - 1] : null;
    }

    _getNextScriptLine (line) {
        const container = this.pageManager ? this.pageManager.container : document;
        const allLines = Array.from(container.querySelectorAll('.script-line'));
        const idx = allLines.indexOf(line);
        return (idx >= 0 && idx < allLines.length - 1) ? allLines[idx + 1] : null;
    }

    _getContainingScriptLine (node) {
        let curr = node;
        while (curr && curr !== document.body) {
            if (curr.classList && curr.classList.contains('script-line')) {
                return curr;
            }
            curr = curr.parentNode;
        }
        return null;
    }

    _emitChange () {
        if (this.contentManager && typeof this.contentManager.emit === 'function') {
            this.contentManager.emit('editor:content-changed', {});
        }
    }
}
