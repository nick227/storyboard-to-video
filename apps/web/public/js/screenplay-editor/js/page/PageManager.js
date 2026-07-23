import { PageFactory } from './PageFactory.js';
import { PageOperations } from './PageOperations.js';
import { PageBreakManager } from './PageBreakManager.js';
import { MAX_LINES_PER_PAGE } from '../constants/editorConstants.js';

export class PageManager {
    constructor (options = {}) {
        this.container = options.container;
        this.maxLinesPerPage = MAX_LINES_PER_PAGE;
        this.pageFactory = new PageFactory();
        this.operations = new PageOperations();
        this.pageBreakManager = new PageBreakManager(this);
    }

    initialize () {
        if (!this.container) return;
        if (this.container.children.length === 0) {
            const initialPage = this.pageFactory.createPage(1);
            this.container.appendChild(initialPage);
        }
    }

    createLine (format = 'action', content = '', id = null) {
        return this.pageFactory.createLine(format, content, id);
    }

    renderDocument (linesData = []) {
        if (!this.container) return;
        this.container.innerHTML = '';

        let currentPage = this.pageFactory.createPage(1);
        this.container.appendChild(currentPage);

        if (linesData.length === 0) {
            const firstLine = this.createLine('action', '', null);
            currentPage.appendChild(firstLine);
            return;
        }

        let lineCount = 0;
        let pageNum = 1;

        linesData.forEach(item => {
            if (lineCount >= this.maxLinesPerPage) {
                pageNum++;
                currentPage = this.pageFactory.createPage(pageNum);
                this.container.appendChild(currentPage);
                lineCount = 0;
            }

            const lineEl = this.createLine(item.format, item.content, item.id);
            currentPage.appendChild(lineEl);
            lineCount++;
        });
    }

    getActiveLine () {
        if (typeof window === 'undefined' || !window.getSelection) return null;
        const sel = window.getSelection();
        if (!sel || !sel.anchorNode) return null;
        let node = sel.anchorNode;
        while (node && node !== this.container) {
            if (node.classList && node.classList.contains('script-line')) {
                return node;
            }
            node = node.parentNode;
        }
        return null;
    }

    getPages () {
        if (!this.container) return [];
        const pageElements = Array.from(this.container.querySelectorAll('.script-page'));
        return pageElements.map(el => ({
            pageNumber: parseInt(el.dataset.pageNumber || '1', 10),
            element: el,
            lines: Array.from(el.querySelectorAll('.script-line'))
        }));
    }

    getPageCount () {
        return this.getPages().length || 1;
    }

    getCurrentPageNumber () {
        const activeLine = this.getActiveLine();
        if (!activeLine) return 1;
        const pageEl = activeLine.closest('.script-page');
        return pageEl ? parseInt(pageEl.dataset.pageNumber || '1', 10) : 1;
    }

    setLinesPerPage (maxLines) {
        if (typeof maxLines === 'number' && maxLines > 0) {
            this.maxLinesPerPage = maxLines;
            if (this.pageBreakManager) {
                this.pageBreakManager.checkAndRecalculate();
            }
        }
    }
}
