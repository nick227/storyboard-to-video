import { EditorCaretManager } from '../handlers/EditorCaretManager.js';

const SELECTED_CLASS = 'is-selected';

/**
 * Row-level multi-select for script lines (Shift+arrows / Shift+click).
 */
export class LineMultiSelect {
    constructor (options = {}) {
        this.pageManager = options.pageManager;
        this.contentManager = options.contentManager;
        this.anchorLine = null;
        this.selected = new Set();
        this._boundClick = this._onClick.bind(this);
        this.editorArea = null;
    }

    initialize (editorArea) {
        this.editorArea = editorArea;
        editorArea.addEventListener('mousedown', this._boundClick);
    }

    destroy () {
        if (this.editorArea) {
            this.editorArea.removeEventListener('mousedown', this._boundClick);
        }
        this.clear();
    }

    getAllLines () {
        const root = this.pageManager?.container || document;
        return Array.from(root.querySelectorAll('.script-line'));
    }

    hasSelection () {
        return this.selected.size > 1;
    }

    getSelectedLines () {
        const all = this.getAllLines();
        return all.filter((line) => this.selected.has(line));
    }

    setAnchor (line) {
        this.clear(false);
        this.anchorLine = line || null;
    }

    clear (removeAnchor = true) {
        this.selected.forEach((line) => line.classList.remove(SELECTED_CLASS));
        this.selected.clear();
        if (removeAnchor) this.anchorLine = null;
    }

    selectRange (fromLine, toLine) {
        const all = this.getAllLines();
        const a = all.indexOf(fromLine);
        const b = all.indexOf(toLine);
        if (a === -1 || b === -1) return;

        this.clear(false);
        this.anchorLine = fromLine;
        const min = Math.min(a, b);
        const max = Math.max(a, b);
        for (let i = min; i <= max; i++) {
            const line = all[i];
            this.selected.add(line);
            if (max > min) line.classList.add(SELECTED_CLASS);
        }
    }

    extendTo (line) {
        if (!line) return;
        if (!this.anchorLine) this.anchorLine = line;
        this.selectRange(this.anchorLine, line);
        EditorCaretManager.setCaretPosition(line, 0);
    }

    navigateWithShift (currentLine, direction) {
        const all = this.getAllLines();
        const idx = all.indexOf(currentLine);
        if (idx === -1) return;
        const nextIdx = direction === 'next' ? idx + 1 : idx - 1;
        if (nextIdx < 0 || nextIdx >= all.length) return;
        if (!this.anchorLine) this.anchorLine = currentLine;
        this.extendTo(all[nextIdx]);
    }

    deleteSelected () {
        const selected = this.getSelectedLines();
        if (selected.length < 2) return false;

        const all = this.getAllLines();
        const indices = selected.map((l) => all.indexOf(l)).filter((i) => i >= 0).sort((a, b) => a - b);
        const focusIdx = indices[0];
        const focusParent = selected[0].parentNode;

        for (let i = indices.length - 1; i >= 0; i--) {
            all[indices[i]].remove();
        }

        this.clear();

        const remaining = this.getAllLines();
        let focusLine = remaining[Math.min(focusIdx, remaining.length - 1)] || null;
        if (!focusLine) {
            focusLine = this.pageManager.createLine('action', '');
            (focusParent || this.pageManager.container?.querySelector('.script-page'))?.appendChild(focusLine);
        }

        EditorCaretManager.setCaretPosition(focusLine, 0);
        this.setAnchor(focusLine);

        if (this.contentManager?.emit) {
            this.contentManager.emit('editor:content-changed', {});
        }
        return true;
    }

    _onClick (e) {
        const line = e.target?.closest?.('.script-line');
        if (!line || !this.editorArea?.contains(line)) return;

        if (e.shiftKey) {
            e.preventDefault();
            if (!this.anchorLine) this.anchorLine = line;
            this.selectRange(this.anchorLine, line);
            EditorCaretManager.setCaretPosition(line, 0);
            return;
        }

        this.setAnchor(line);
    }
}
