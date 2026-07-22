import { RawScriptAdapter } from './adapters/RawScriptAdapter.js';
import { LineFormatter } from './LineFormatter.js';
import { KeyboardManager } from './keyboard/KeyboardManager.js';
import { PageManager } from './page/PageManager.js';
import { EditorDOMHandler } from './handlers/EditorDOMHandler.js';
import { HelpModal } from './ui/HelpModal.js';
import { ViewportScaler } from './ui/ViewportScaler.js';
import { EDITOR_EVENTS } from './constants/editorConstants.js';
import { VALID_FORMATS, FORMAT_DISPLAY_NAMES } from './constants/formats.js';

/**
 * ScreenplayEditor: A standalone, portable Screenplay Writing UX Component.
 * Can be embedded in any Web application with ZERO external dependencies.
 */
export class ScreenplayEditor {
    /**
     * @param {object} options
     * @param {HTMLElement} options.container - Container element to mount editor into
     * @param {string|Array} [options.initialScript=''] - Initial raw script text (Fountain, Tagged HTML, or JSON)
     * @param {string} [options.format='fountain'] - Input format ('fountain' | 'tagged' | 'json' | 'array')
     * @param {boolean} [options.showToolbar=true] - Whether to render built-in toolbar
     * @param {HTMLElement} [options.toolbarHost] - Optional external host for format chips (70% column)
     * @param {HTMLElement} [options.toolbarMetaHost] - Optional external host for page badge / theme
     * @param {function} [options.onChange] - Callback fired whenever script content changes
     * @param {function} [options.onSelectionChange] - Callback fired whenever selection/cursor format changes
     */
    constructor (options = {}) {
        if (!options.container) {
            throw new Error('[ScreenplayEditor] Container element is required');
        }

        this.container = options.container;
        this.format = options.format || 'fountain';
        this.showToolbar = options.showToolbar !== false;
        this.toolbarHost = options.toolbarHost || null;
        this.toolbarMetaHost = options.toolbarMetaHost || null;
        this.theme = options.theme || 'dark';

        this.callbacks = {
            onChange: options.onChange || null,
            onSelectionChange: options.onSelectionChange || null
        };

        // State
        this.document = RawScriptAdapter.parse(options.initialScript || '', this.format);
        this.isDirty = false;

        // Sub-modules
        this.lineFormatter = new LineFormatter();
        this.pageManager = null;
        this.domHandler = null;
        this.keyboardManager = null;
        this.helpModal = null;
        this.viewportScaler = null;

        // Elements
        this.wrapper = null;
        this.toolbar = null;
        this.workspace = null;
        this.scaleShell = null;
        this.scaleTarget = null;

        this._initUI();
        this.helpModal = new HelpModal({ themeHost: this.wrapper });
        this._initEngine();
        this.loadScript(options.initialScript || '', this.format);
    }

    _initUI () {
        this.container.innerHTML = '';

        this.wrapper = document.createElement('div');
        this.wrapper.className = `screenplay-editor-wrapper theme-${this.theme}`;

        if (this.showToolbar) {
            this._buildToolbarUI();
        }

        this.workspace = document.createElement('div');
        this.workspace.className = 'screenplay-workspace';

        this.scaleShell = document.createElement('div');
        this.scaleShell.className = 'screenplay-scale-shell';

        this.scaleTarget = document.createElement('div');
        this.scaleTarget.className = 'screenplay-scale-target';

        this.scaleShell.appendChild(this.scaleTarget);
        this.workspace.appendChild(this.scaleShell);
        this.wrapper.appendChild(this.workspace);
        this.container.appendChild(this.wrapper);
    }

    _buildToolbarUI () {
        const chipsGroup = document.createElement('div');
        chipsGroup.className = 'screenplay-toolbar-chips';

        this.chipButtons = {};
        Object.keys(FORMAT_DISPLAY_NAMES).forEach(fmt => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'screenplay-chip';
            btn.dataset.format = fmt;
            btn.textContent = FORMAT_DISPLAY_NAMES[fmt];
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                this.setLineFormat(fmt);
            });
            chipsGroup.appendChild(btn);
            this.chipButtons[fmt] = btn;
        });

        const helpBtn = document.createElement('button');
        helpBtn.type = 'button';
        helpBtn.className = 'screenplay-help-btn';
        helpBtn.setAttribute('aria-label', 'Screenplay editor help');
        helpBtn.title = 'Keyboard shortcuts';
        helpBtn.textContent = '?';
        helpBtn.addEventListener('click', (e) => {
            e.preventDefault();
            this.helpModal.open();
        });
        chipsGroup.appendChild(helpBtn);

        this.pageBadge = document.createElement('span');
        this.pageBadge.className = 'screenplay-page-badge';
        this.pageBadge.title = 'Approximate page count until deterministic pagination';
        this.pageBadge.textContent = '≈ Page 1 of 1';

        const themeBtn = document.createElement('button');
        themeBtn.type = 'button';
        themeBtn.className = 'screenplay-theme-btn';
        themeBtn.textContent = this.theme === 'dark' ? '☀️ Light' : '🌙 Dark';
        themeBtn.addEventListener('click', (e) => {
            e.preventDefault();
            this.setTheme(this.theme === 'dark' ? 'light' : 'dark');
        });
        this.themeBtn = themeBtn;

        if (this.toolbarHost) {
            this.toolbarHost.innerHTML = '';
            this.toolbarHost.hidden = false;
            this.toolbarHost.classList.add('screenplay-toolbar', 'is-hosted', `theme-${this.theme}`);
            this.toolbarHost.appendChild(chipsGroup);
            this.toolbar = this.toolbarHost;

            if (this.toolbarMetaHost) {
                this.toolbarMetaHost.innerHTML = '';
                this.toolbarMetaHost.hidden = false;
                this.toolbarMetaHost.classList.add('screenplay-toolbar-meta', `theme-${this.theme}`);
                this.toolbarMetaHost.append(this.pageBadge, themeBtn);
            } else {
                const rightGroup = document.createElement('div');
                rightGroup.className = 'screenplay-toolbar-right';
                rightGroup.append(this.pageBadge, themeBtn);
                this.toolbarHost.appendChild(rightGroup);
            }
            return;
        }

        this.toolbar = document.createElement('div');
        this.toolbar.className = 'screenplay-toolbar';
        this.toolbar.appendChild(chipsGroup);

        const rightGroup = document.createElement('div');
        rightGroup.className = 'screenplay-toolbar-right';
        rightGroup.append(this.pageBadge, themeBtn);
        this.toolbar.appendChild(rightGroup);
        this.wrapper.appendChild(this.toolbar);
    }

    _initEngine () {
        this.pageManager = new PageManager({
            container: this.scaleTarget,
            lineFormatter: this.lineFormatter
        });
        this.pageManager.initialize();

        this.domHandler = new EditorDOMHandler({
            pageManager: this.pageManager,
            lineFormatter: this.lineFormatter
        });

        const mockContentManager = {
            emit: (event, data) => this._handleEngineEvent(event, data)
        };

        this.keyboardManager = new KeyboardManager({
            pageManager: this.pageManager,
            contentManager: mockContentManager,
            lineFormatter: this.lineFormatter,
            domHandler: this.domHandler
        });

        this.keyboardManager.initialize(this.workspace);

        this.viewportScaler = new ViewportScaler({
            wrapper: this.wrapper,
            workspace: this.workspace,
            shell: this.scaleShell,
            target: this.scaleTarget
        });
        this.viewportScaler.start();

        this.workspace.addEventListener('input', () => this._notifyChange());
        this.workspace.addEventListener('keyup', () => this._updateSelectionState());
        this.workspace.addEventListener('click', () => this._updateSelectionState());
    }

    loadScript (content, format = 'fountain') {
        this.format = format;
        this.document = RawScriptAdapter.parse(content, format);

        const linesData = this.document.lines.map(l => ({
            id: l.id,
            format: l.format,
            content: l.content
        }));

        this.pageManager.renderDocument(linesData);
        this.isDirty = false;
        this._updateSelectionState();
        if (this.viewportScaler) this.viewportScaler.scheduleUpdate();
    }

    getRawScript (format) {
        const currentDoc = this.getScriptDocument();
        return RawScriptAdapter.serialize(currentDoc, format || this.format);
    }

    getScriptDocument () {
        const lineElements = Array.from(this.workspace.querySelectorAll('.script-line'));
        const linesData = lineElements.map(el => ({
            id: el.dataset.lineId || el.id,
            format: el.getAttribute('data-format') || VALID_FORMATS.ACTION,
            content: el.textContent || ''
        }));
        return RawScriptAdapter.fromArray(linesData);
    }

    setLineFormat (format) {
        const activeLine = this.pageManager.getActiveLine() || this.workspace.querySelector('.script-line');
        if (activeLine) {
            activeLine.setAttribute('data-format', format);
            this._notifyChange();
        }
    }

    setTheme (theme) {
        this.theme = theme === 'light' ? 'light' : 'dark';
        if (this.wrapper) {
            this.wrapper.classList.remove('theme-dark', 'theme-light');
            this.wrapper.classList.add(`theme-${this.theme}`);
        }
        [this.toolbarHost, this.toolbarMetaHost].forEach((el) => {
            if (!el) return;
            el.classList.remove('theme-dark', 'theme-light');
            el.classList.add(`theme-${this.theme}`);
        });
        if (this.themeBtn) {
            this.themeBtn.textContent = this.theme === 'dark' ? '☀️ Light' : '🌙 Dark';
        }
    }

    getPages () {
        return this.pageManager ? this.pageManager.getPages() : [];
    }

    getPageCount () {
        return this.pageManager ? this.pageManager.getPageCount() : 1;
    }

    getCurrentPageNumber () {
        return this.pageManager ? this.pageManager.getCurrentPageNumber() : 1;
    }

    setLinesPerPage (maxLines) {
        if (this.pageManager) {
            this.pageManager.setLinesPerPage(maxLines);
            this._updatePageBadge();
        }
    }

    _notifyChange () {
        this.isDirty = true;
        const currentDoc = this.getScriptDocument();
        const rawText = RawScriptAdapter.serialize(currentDoc, this.format);
        this._updatePageBadge();

        if (typeof this.callbacks.onChange === 'function') {
            this.callbacks.onChange({
                rawText,
                document: currentDoc,
                isDirty: true
            });
        }
    }

    _updateSelectionState () {
        const activeLine = this.pageManager.getActiveLine();
        if (activeLine) {
            const currentFormat = activeLine.getAttribute('data-format') || VALID_FORMATS.ACTION;
            if (this.chipButtons) {
                Object.keys(this.chipButtons).forEach(fmt => {
                    this.chipButtons[fmt].classList.toggle('is-active', fmt === currentFormat);
                });
            }

            this._updatePageBadge();

            if (typeof this.callbacks.onSelectionChange === 'function') {
                this.callbacks.onSelectionChange({
                    format: currentFormat,
                    lineElement: activeLine
                });
            }
        } else {
            this._updatePageBadge();
        }
    }

    _updatePageBadge () {
        if (this.pageBadge && this.pageManager) {
            const current = this.pageManager.getCurrentPageNumber();
            const total = this.pageManager.getPageCount();
            this.pageBadge.textContent = `≈ Page ${current} of ${total}`;
            this.pageBadge.title = 'Approximate page count until deterministic pagination';
        }
        if (this.viewportScaler) this.viewportScaler.scheduleUpdate();
    }

    _handleEngineEvent (event, data) {
        if (event === EDITOR_EVENTS.CONTENT_CHANGED) {
            this._notifyChange();
        }
    }

    destroy () {
        if (this.viewportScaler) {
            this.viewportScaler.destroy();
            this.viewportScaler = null;
        }
        if (this.keyboardManager) {
            this.keyboardManager.destroy();
        }
        if (this.helpModal) {
            this.helpModal.destroy();
        }
        if (this.toolbarHost) {
            this.toolbarHost.innerHTML = '';
            this.toolbarHost.hidden = true;
        }
        if (this.toolbarMetaHost) {
            this.toolbarMetaHost.innerHTML = '';
            this.toolbarMetaHost.hidden = true;
        }
        this.container.innerHTML = '';
    }
}
