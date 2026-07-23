import { getNextFormat } from '../constants/formats.js';
import { KeyboardEditController } from './KeyboardEditController.js';
import { KeyboardSelectionController } from './KeyboardSelectionController.js';
import { EditorCaretManager } from '../handlers/EditorCaretManager.js';
import { LineMultiSelect } from '../selection/LineMultiSelect.js';

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

        this.multiSelect = new LineMultiSelect({
            pageManager: this.pageManager,
            contentManager: this.contentManager
        });

        this._boundHandlers = {
            keydown: this._handleKeyDown.bind(this)
        };
    }

    initialize (editorArea) {
        if (!editorArea) return;
        this.editorArea = editorArea;
        this.selectionController.setEditorArea(editorArea);
        this.multiSelect.initialize(editorArea);
        this.editorArea.addEventListener('keydown', this._boundHandlers.keydown);
    }

    destroy () {
        if (this.editorArea) {
            this.editorArea.removeEventListener('keydown', this._boundHandlers.keydown);
        }
        this.multiSelect.destroy();
        this.selectionController.destroy();
        this.editController.destroy();
    }

    _handleKeyDown (e) {
        const activeLine = this.pageManager ? this.pageManager.getActiveLine() : null;
        if (!activeLine) return;

        const selection = window.getSelection();

        if ((e.key === 'Backspace' || e.key === 'Delete') && this.multiSelect.hasSelection()) {
            e.preventDefault();
            this.multiSelect.deleteSelected();
            return;
        }

        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            this.multiSelect.setAnchor(activeLine);
            this.editController.handleEnter(activeLine);
            return;
        }

        if (e.key === 'Tab') {
            e.preventDefault();
            this._cycleFormat(activeLine, e.shiftKey ? -1 : 1);
            return;
        }

        if (e.ctrlKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
            e.preventDefault();
            this._cycleFormat(activeLine, e.key === 'ArrowRight' ? 1 : -1);
            return;
        }

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

        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            const direction = e.key === 'ArrowDown' ? 'next' : 'previous';
            if (e.shiftKey) {
                e.preventDefault();
                this.multiSelect.navigateWithShift(activeLine, direction);
                return;
            }
            this.multiSelect.setAnchor(
                this.selectionController.navigateLine(activeLine, direction) || activeLine
            );
        }
    }

    _cycleFormat (line, direction) {
        const currentFormat = line.getAttribute('data-format') || 'action';
        line.setAttribute('data-format', getNextFormat(currentFormat, direction));
        if (this.contentManager?.emit) {
            this.contentManager.emit('editor:content-changed', {});
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
