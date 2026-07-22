const SHORTCUTS = [
    { keys: 'Ctrl + ← / →', desc: 'Cycle the active line type (Scene Heading → Action → Character → Dialogue → Parenthetical → Transition)' },
    { keys: 'Tab / Shift + Tab', desc: 'Cycle line type forward or backward' },
    { keys: 'Shift + ↑ / ↓', desc: 'Multi-select consecutive lines with the keyboard' },
    { keys: 'Shift + Click', desc: 'Multi-select a range of lines with the mouse' },
    { keys: 'Delete / Backspace', desc: 'Delete all multi-selected lines at once' },
    { keys: 'Enter', desc: 'Insert a new line using the natural format flow (e.g. Character → Dialogue)' }
];

/**
 * Lightweight help dialog for screenplay editor shortcuts.
 */
export class HelpModal {
    /**
     * @param {{ themeHost?: HTMLElement }} [options]
     */
    constructor (options = {}) {
        this.themeHost = options.themeHost || null;
        this.dialog = null;
    }

    open () {
        if (!this.dialog) this._build();
        this._syncTheme();
        this.dialog.showModal();
    }

    destroy () {
        if (this.dialog) {
            this.dialog.remove();
            this.dialog = null;
        }
    }

    _syncTheme () {
        if (!this.dialog) return;
        this.dialog.classList.remove('theme-dark', 'theme-light');
        const theme = this.themeHost?.classList.contains('theme-light') ? 'light' : 'dark';
        this.dialog.classList.add(`theme-${theme}`);
    }

    _build () {
        const dialog = document.createElement('dialog');
        dialog.className = 'screenplay-help-modal';

        const header = document.createElement('div');
        header.className = 'screenplay-help-header';
        const title = document.createElement('h2');
        title.textContent = 'Screenplay editor help';
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'screenplay-help-close';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', () => dialog.close());
        header.append(title, closeBtn);

        const intro = document.createElement('p');
        intro.className = 'screenplay-help-intro';
        intro.textContent = 'Write in screenplay format with keyboard shortcuts for line types and multi-select.';

        const list = document.createElement('dl');
        list.className = 'screenplay-help-list';
        SHORTCUTS.forEach(({ keys, desc }) => {
            const dt = document.createElement('dt');
            dt.textContent = keys;
            const dd = document.createElement('dd');
            dd.textContent = desc;
            list.append(dt, dd);
        });

        dialog.append(header, intro, list);
        dialog.addEventListener('click', (e) => {
            if (e.target === dialog) dialog.close();
        });

        document.body.appendChild(dialog);
        this.dialog = dialog;
    }
}
