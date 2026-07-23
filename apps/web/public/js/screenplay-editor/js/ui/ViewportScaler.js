/**
 * Scales the canonical Letter page to fit the workspace width.
 * Narrow viewports switch to fluid editing mode for usability.
 */
const PAGE_WIDTH_IN = 8.5;
const WORKSPACE_PAD_PX = 32;
const FLUID_MAX_WIDTH_PX = 520;
const MIN_SCALE = 0.45;

function inchesToPx (inches) {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;width:1in;pointer-events:none';
    document.body.appendChild(probe);
    const px = probe.offsetWidth || 96;
    probe.remove();
    return inches * px;
}

export class ViewportScaler {
    /**
     * @param {{ wrapper: HTMLElement, workspace: HTMLElement, shell: HTMLElement, target: HTMLElement }} els
     */
    constructor (els) {
        this.wrapper = els.wrapper;
        this.workspace = els.workspace;
        this.shell = els.shell;
        this.target = els.target;
        this._pageWidthPx = inchesToPx(PAGE_WIDTH_IN);
        this._raf = 0;
        this._ro = null;
        this._onWinResize = () => this.scheduleUpdate();
    }

    start () {
        this._ro = new ResizeObserver(() => this.scheduleUpdate());
        this._ro.observe(this.workspace);
        this._ro.observe(this.target);
        window.addEventListener('resize', this._onWinResize);
        this.update();
    }

    destroy () {
        if (this._ro) this._ro.disconnect();
        window.removeEventListener('resize', this._onWinResize);
        if (this._raf) cancelAnimationFrame(this._raf);
    }

    scheduleUpdate () {
        if (this._raf) return;
        this._raf = requestAnimationFrame(() => {
            this._raf = 0;
            this.update();
        });
    }

    update () {
        const available = this.workspace.clientWidth - WORKSPACE_PAD_PX;
        const raw = available / this._pageWidthPx;
        const useFluid = available < FLUID_MAX_WIDTH_PX || raw < MIN_SCALE;

        this.wrapper.classList.toggle('is-fluid', useFluid);

        if (useFluid) {
            this.wrapper.style.setProperty('--page-scale', '1');
            this.shell.style.removeProperty('--pages-height');
            return;
        }

        const scale = Math.min(1, raw);
        this.wrapper.style.setProperty('--page-scale', String(scale));

        const targetHeight = this.target.scrollHeight || this._pageWidthPx * (11 / 8.5);
        this.shell.style.setProperty('--pages-height', `${targetHeight}px`);
    }
}
