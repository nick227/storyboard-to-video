import { getNextFormat } from '../constants/formats.js';
import { KeyboardEditController } from './KeyboardEditController.js';
import { KeyboardSelectionController } from './KeyboardSelectionController.js';

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

        // 1. Enter key: Advance format flow (Action -> Speaker -> Dialog -> Speaker)
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

        // 3. Arrow Up / Down navigation
        if (e.key === 'ArrowDown') {
            this.selectionController.navigateLine(activeLine, 'next');
        } else if (e.key === 'ArrowUp') {
            this.selectionController.navigateLine(activeLine, 'previous');
        }
    }
}
