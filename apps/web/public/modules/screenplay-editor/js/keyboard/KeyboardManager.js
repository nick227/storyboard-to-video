import { getNextFormat } from '../constants/formats.js';
import { KeyboardEditController } from './KeyboardEditController.js';
import { KeyboardSelectionController } from './KeyboardSelectionController.js';
import { EditorCaretManager } from '../handlers/EditorCaretManager.js';

export class KeyboardManager {
    constructor (options = {}) {
        this.pageManager = options.pageManager;
        this.contentManager = options.contentManager;
        this.lineFormatter = options.lineFormatter;
        this.editorArea = null;

        this.editController = new KeyboardEditController({
            pageManager: this.pageManager,
            contentManager: this.contentManager
        });

        this.selectionController = new KeyboardSelectionController({
            pageManager: this.pageManager
        });

        this._boundHandlers = {
            keydown: this._handleKeyDown.bind(this)
        };
    }

    initialize (editorArea) {
        if (!editorArea) return;
        this.editorArea = editorArea;
        this.selectionController.setEditorArea(editorArea);
        this.editorArea.addEventListener('keydown', this._boundHandlers.keydown);
    }

    destroy () {
        if (this.editorArea) {
            this.editorArea.removeEventListener('keydown', this._boundHandlers.keydown);
        }
        this.selectionController.destroy();
        this.editController.destroy();
    }

    _handleKeyDown (e) {
        const activeLine = this.pageManager ? this.pageManager.getActiveLine() : null;
        if (!activeLine) return;

        const selection = window.getSelection();

        // 1. Enter key: Advance format flow
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            this.editController.handleEnter(activeLine);
            return;
        }

        // 2. Tab / Shift+Tab key: Cycle line formats
        if (e.key === 'Tab') {
            e.preventDefault();
            const currentFormat = activeLine.getAttribute('data-format') || 'action';
            const direction = e.shiftKey ? -1 : 1;
            const nextFormat = getNextFormat(currentFormat, direction);
            activeLine.setAttribute('data-format', nextFormat);

            if (this.contentManager && typeof this.contentManager.emit === 'function') {
                this.contentManager.emit('editor:content-changed', {});
            }
            return;
        }

        // 3. Backspace key: Line merge / empty line deletion
        if (e.key === 'Backspace') {
            if (selection && !selection.isCollapsed && this._isMultiLineSelection(selection)) {
                e.preventDefault();
                this.editController.handleMultiLineDelete(selection);
                return;
            }

            const pos = EditorCaretManager.getCaretPosition(activeLine);
            if (pos === 0) {
                e.preventDefault();
                this.editController.handleBackspace(activeLine);
                return;
            }
        }

        // 4. Delete key: Merge next line into current
        if (e.key === 'Delete') {
            if (selection && !selection.isCollapsed && this._isMultiLineSelection(selection)) {
                e.preventDefault();
                this.editController.handleMultiLineDelete(selection);
                return;
            }

            const textLen = activeLine.textContent ? activeLine.textContent.length : 0;
            const pos = EditorCaretManager.getCaretPosition(activeLine);
            if (pos >= textLen) {
                e.preventDefault();
                this.editController.handleDelete(activeLine);
                return;
            }
        }

        // 5. Arrow Up / Down navigation
        if (e.key === 'ArrowDown') {
            this.selectionController.navigateLine(activeLine, 'next');
        } else if (e.key === 'ArrowUp') {
            this.selectionController.navigateLine(activeLine, 'previous');
        }
    }

    _isMultiLineSelection (selection) {
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
        const range = selection.getRangeAt(0);
        const startLine = this._getContainingScriptLine(range.startContainer);
        const endLine = this._getContainingScriptLine(range.endContainer);
        return startLine && endLine && startLine !== endLine;
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
}
