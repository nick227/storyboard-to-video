import { EditorCaretManager } from '../handlers/EditorCaretManager.js';

const HEIGHT_EPSILON_PX = 1;
const MAX_REFLOW_MOVES = 10000;

/**
 * Keeps existing line elements distributed across fixed-height screenplay pages.
 * Reparenting the existing nodes preserves their ids, listeners, and edit state.
 */
export class PageBreakManager {
    constructor (pageManager) {
        this.pageManager = pageManager;
        this._raf = 0;
        this._isReflowing = false;
        this._measurementHost = null;
        this._measurementPage = null;
    }

    schedule () {
        if (this._raf) return;
        this._raf = requestAnimationFrame(() => {
            this._raf = 0;
            this.checkAndRecalculate();
        });
    }

    destroy () {
        if (this._raf) cancelAnimationFrame(this._raf);
        this._raf = 0;
        this._measurementHost?.remove();
        this._measurementHost = null;
        this._measurementPage = null;
    }

    checkAndRecalculate () {
        const manager = this.pageManager;
        const container = manager?.container;
        if (!container || this._isReflowing) return false;

        let pages = Array.from(container.querySelectorAll('.script-page'));
        if (pages.length === 0) {
            const page = manager.pageFactory.createPage(1);
            container.appendChild(page);
            pages = [page];
        }

        // Normal input that does not cross a page boundary must not touch focus,
        // selection, or window scroll state.
        if (!this._needsReflow(pages)) return false;

        const activeLine = manager.getActiveLine();
        const caretOffset = activeLine ? EditorCaretManager.getCaretPosition(activeLine) : 0;
        const activeTop = activeLine?.getBoundingClientRect().top;
        let moves = 0;

        this._isReflowing = true;
        try {
            // Push overflowing tail blocks forward until every measurable page fits.
            for (let index = 0; index < pages.length && moves < MAX_REFLOW_MOVES; index++) {
                const page = pages[index];
                while (this._pageOverflows(page) && page.children.length > 1 && moves < MAX_REFLOW_MOVES) {
                    let nextPage = pages[index + 1];
                    if (!nextPage) {
                        nextPage = manager.pageFactory.createPage(pages.length + 1);
                        container.appendChild(nextPage);
                        pages.push(nextPage);
                    }

                    const block = this._tailBlock(page);
                    if (block.length === 0
                        || block.length === page.children.length
                        || !this._blockFitsEmptyPage(block)) {
                        this._moveToStart([page.lastElementChild], nextPage);
                    } else {
                        this._moveToStart(block, nextPage);
                    }
                    moves++;
                }
            }

            // Pull content back after deletions or format changes, without splitting
            // speaker/dialogue and scene-heading/action pairs when they fit together.
            for (let index = 0; index < pages.length - 1 && moves < MAX_REFLOW_MOVES;) {
                const page = pages[index];
                const nextPage = pages[index + 1];
                const block = this._headBlock(nextPage);

                if (block.length === 0) {
                    nextPage.remove();
                    pages.splice(index + 1, 1);
                    continue;
                }

                if (!this._blockFitsAtEnd(page, block)) {
                    index++;
                    continue;
                }

                block.forEach(line => page.appendChild(line));
                moves++;
                if (this._pageOverflows(page)) {
                    this._moveToStart(block, nextPage);
                    index++;
                    continue;
                }

                if (nextPage.children.length === 0) {
                    nextPage.remove();
                    pages.splice(index + 1, 1);
                }
            }

            pages = Array.from(container.querySelectorAll('.script-page'));
            pages.forEach((page, index) => {
                page.dataset.pageNumber = String(index + 1);
            });
        } finally {
            this._isReflowing = false;
        }

        if (moves > 0 && activeLine?.isConnected) {
            const selectionStillActive = manager.getActiveLine() === activeLine;
            if (!selectionStillActive) {
                EditorCaretManager.setCaretPosition(activeLine, caretOffset, { preventScroll: true });
            }

            if (Number.isFinite(activeTop)) {
                const nextTop = activeLine.getBoundingClientRect().top;
                const delta = nextTop - activeTop;
                if (Math.abs(delta) >= 1) window.scrollBy(0, delta);
            }
        }

        return moves > 0;
    }

    _pageOverflows (page) {
        const maxLines = this.pageManager.maxLinesPerPage || 54;
        if (page.children.length > maxLines) return true;
        if (this._usesCanonicalProbe(page)) {
            return this._canonicalPageOverflows(Array.from(page.children));
        }
        // Headless tests and hidden containers have no measurable box; line count
        // remains their deterministic fallback.
        if (page.clientHeight <= 0) return false;
        return page.scrollHeight > page.clientHeight + HEIGHT_EPSILON_PX;
    }

    _blockFitsAtEnd (page, block) {
        const maxLines = this.pageManager.maxLinesPerPage || 54;
        if (page.children.length + block.length > maxLines) return false;
        if (this._usesCanonicalProbe(page)) {
            return !this._canonicalPageOverflows([...page.children, ...block]);
        }

        // In the browser, measure inert copies so an active contenteditable node is
        // never detached merely to test whether it fits on the previous page.
        if (block.every(line => typeof line.cloneNode === 'function')) {
            const clones = block.map(line => line.cloneNode(true));
            clones.forEach(clone => {
                clone.removeAttribute?.('id');
                clone.removeAttribute?.('data-line-id');
                clone.contentEditable = 'false';
                clone.setAttribute?.('aria-hidden', 'true');
                page.appendChild(clone);
            });
            const fits = !this._pageOverflows(page);
            clones.forEach(clone => clone.remove());
            return fits;
        }

        // Lightweight DOM fakes used by unit tests expose explicit height metrics.
        if (block.every(line => Number.isFinite(line.height))) {
            const blockHeight = block.reduce((total, line) => total + line.height, 0);
            return page.scrollHeight + blockHeight <= page.clientHeight + HEIGHT_EPSILON_PX;
        }

        return false;
    }

    _blockFitsEmptyPage (block) {
        const maxLines = this.pageManager.maxLinesPerPage || 54;
        if (block.length > maxLines) return false;
        if (block.every(line => typeof line.cloneNode === 'function')) {
            return !this._canonicalPageOverflows(block);
        }
        if (block.every(line => Number.isFinite(line.height))) {
            const blockHeight = block.reduce((total, line) => total + line.height, 0);
            const emptyPage = this.pageManager.pageFactory.createPage(0);
            return blockHeight <= emptyPage.clientHeight + HEIGHT_EPSILON_PX;
        }
        return true;
    }

    _needsReflow (pages) {
        if (pages.some(page => this._pageOverflows(page))) return true;
        for (let index = 0; index < pages.length - 1; index++) {
            const block = this._headBlock(pages[index + 1]);
            if (block.length === 0 || this._blockFitsAtEnd(pages[index], block)) return true;
        }
        return false;
    }

    _usesCanonicalProbe (page) {
        const wrapper = page.closest?.('.screenplay-editor-wrapper');
        return Boolean(wrapper?.classList.contains('is-fluid'));
    }

    _canonicalPageOverflows (lines) {
        const page = this._canonicalMeasurementPage();
        if (!page) return false;
        page.replaceChildren();
        lines.forEach(line => {
            const clone = line.cloneNode(true);
            clone.removeAttribute('id');
            clone.removeAttribute('data-line-id');
            clone.contentEditable = 'false';
            clone.setAttribute('aria-hidden', 'true');
            page.appendChild(clone);
        });
        return page.scrollHeight > page.clientHeight + HEIGHT_EPSILON_PX;
    }

    _canonicalMeasurementPage () {
        if (this._measurementPage?.isConnected) return this._measurementPage;
        if (typeof document === 'undefined' || !document.body) return null;

        const sourceWrapper = this.pageManager.container.closest?.('.screenplay-editor-wrapper');
        if (!sourceWrapper) return null;

        const host = document.createElement('div');
        host.className = sourceWrapper.className.replace(/\bis-fluid\b/g, '').replace(/\s+/g, ' ').trim();
        host.classList.add('screenplay-pagination-measure');
        host.setAttribute('aria-hidden', 'true');
        const page = this.pageManager.pageFactory.createPage(0);
        host.appendChild(page);
        document.body.appendChild(host);
        this._measurementHost = host;
        this._measurementPage = page;
        return page;
    }

    _tailBlock (page) {
        const children = Array.from(page.children);
        if (children.length === 0) return [];
        let start = children.length - 1;
        const lastFormat = this._format(children[start]);

        if (lastFormat === 'dialog' || lastFormat === 'directions') {
            while (start > 0 && ['dialog', 'directions'].includes(this._format(children[start - 1]))) start--;
            if (start > 0 && this._format(children[start - 1]) === 'speaker') start--;
        } else if (lastFormat === 'action' && start > 0 && this._format(children[start - 1]) === 'header') {
            start--;
        }

        return children.slice(start);
    }

    _headBlock (page) {
        const children = Array.from(page.children);
        if (children.length === 0) return [];
        let end = 1;
        const firstFormat = this._format(children[0]);

        if (firstFormat === 'speaker') {
            while (end < children.length && ['directions', 'dialog'].includes(this._format(children[end]))) end++;
        } else if (firstFormat === 'header' && this._format(children[1]) === 'action') {
            end = 2;
        }

        return children.slice(0, end);
    }

    _moveToStart (lines, page) {
        for (let index = lines.length - 1; index >= 0; index--) {
            page.insertBefore(lines[index], page.firstElementChild);
        }
    }

    _format (line) {
        return line?.getAttribute('data-format') || 'action';
    }
}
