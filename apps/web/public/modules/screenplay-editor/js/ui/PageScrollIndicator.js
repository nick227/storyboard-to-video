/**
 * Minimal floating page position indicator shown while scrolling.
 */
const HIDE_MS = 900;

export class PageScrollIndicator {
    /**
     * @param {{
     *   wrapper: HTMLElement,
     *   workspace: HTMLElement,
     *   pageManager: { getPageCount: Function, getPages: Function }
     * }} options
     */
    constructor (options = {}) {
        this.wrapper = options.wrapper;
        this.workspace = options.workspace;
        this.pageManager = options.pageManager;
        this.el = null;
        this._hideTimer = 0;
        this._raf = 0;
        this._onScroll = () => this._handleScroll();
    }

    start () {
        this.el = document.createElement('div');
        this.el.className = 'screenplay-page-float';
        this.el.setAttribute('aria-live', 'polite');
        this.el.title = 'Approximate page count until deterministic pagination';
        this.wrapper.appendChild(this.el);
        this.workspace.addEventListener('scroll', this._onScroll, { passive: true });
        this.refresh(false);
    }

    destroy () {
        this.workspace.removeEventListener('scroll', this._onScroll);
        if (this._hideTimer) clearTimeout(this._hideTimer);
        if (this._raf) cancelAnimationFrame(this._raf);
        if (this.el) this.el.remove();
        this.el = null;
    }

    /** Recalculate totals after document changes; optionally flash visible. */
    refresh (show = false) {
        if (!this.el) return;
        const { current, total } = this._visiblePage();
        this.el.textContent = `${current} / ${total}`;
        if (show) this._flash();
    }

    _handleScroll () {
        if (this._raf) return;
        this._raf = requestAnimationFrame(() => {
            this._raf = 0;
            const { current, total } = this._visiblePage();
            this.el.textContent = `${current} / ${total}`;
            this._flash();
        });
    }

    _flash () {
        this.el.classList.add('is-visible');
        if (this._hideTimer) clearTimeout(this._hideTimer);
        this._hideTimer = setTimeout(() => {
            if (this.el) this.el.classList.remove('is-visible');
        }, HIDE_MS);
    }

    _visiblePage () {
        const pages = this.pageManager.getPages();
        const total = Math.max(1, pages.length);
        if (pages.length === 0) return { current: 1, total: 1 };

        const viewMid = this.workspace.scrollTop + this.workspace.clientHeight / 2;
        const workspaceRect = this.workspace.getBoundingClientRect();

        let best = pages[0];
        let bestDist = Infinity;

        for (const page of pages) {
            const rect = page.element.getBoundingClientRect();
            const pageMid = (rect.top - workspaceRect.top) + this.workspace.scrollTop + rect.height / 2;
            const dist = Math.abs(pageMid - viewMid);
            if (dist < bestDist) {
                bestDist = dist;
                best = page;
            }
        }

        return {
            current: best.pageNumber || 1,
            total
        };
    }
}
