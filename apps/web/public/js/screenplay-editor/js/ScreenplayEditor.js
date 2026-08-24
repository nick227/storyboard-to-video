import { RawScriptAdapter } from './adapters/RawScriptAdapter.js';
import { LineFormatter } from './LineFormatter.js';
import { KeyboardManager } from './keyboard/KeyboardManager.js';
import { PageManager } from './page/PageManager.js';
import { EditorDOMHandler } from './handlers/EditorDOMHandler.js';
import { HelpModal } from './ui/HelpModal.js';
import { ViewportScaler } from './ui/ViewportScaler.js';
import { PageScrollIndicator } from './ui/PageScrollIndicator.js';
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
     * @param {HTMLElement} [options.toolbarHost] - Optional external host for the line-type control
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
        this.theme = options.theme || 'dark';

        this.callbacks = {
            onChange: options.onChange || null,
            onSelectionChange: options.onSelectionChange || null,
            onTitlePageChange: options.onTitlePageChange || null,
            onTitlePageCoverClick: options.onTitlePageCoverClick || null
        };
        this.titlePageMeta = { ...(options.titlePage || {}) };

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
        this.pageScrollIndicator = null;

        // Elements
        this.wrapper = null;
        this.toolbar = null;
        this.workspace = null;
        this.scaleShell = null;
        this.scaleTarget = null;
        this.titlePage = null;
        this.titlePageFields = {};
        this.scriptPages = null;

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

        this.titlePage = this._buildTitlePageUI();
        this.scriptPages = document.createElement('div');
        this.scriptPages.className = 'screenplay-script-pages';

        this.scaleTarget.append(this.titlePage, this.scriptPages);
        this.scaleShell.appendChild(this.scaleTarget);
        this.workspace.appendChild(this.scaleShell);
        this.wrapper.appendChild(this.workspace);
        this.container.appendChild(this.wrapper);
    }

    _buildTitlePageUI () {
        const page = document.createElement('section');
        page.className = 'script-page screenplay-title-page';
        page.dataset.pageNumber = '0';
        page.setAttribute('aria-label', 'Screenplay title page');

        const main = document.createElement('div');
        main.className = 'screenplay-title-page-main';
        const title = this._createTitlePageField('title', 'Untitled screenplay', 'h1');
        const credit = document.createElement('p');
        credit.className = 'screenplay-title-page-credit';
        credit.textContent = 'Written by';
        const author = this._createTitlePageField('author', 'Author name');

        const optional = document.createElement('div');
        optional.className = 'screenplay-title-page-optional';
        const logline = this._createTitlePageField('logline', 'Add a concise logline');
        logline.setAttribute('aria-multiline', 'true');
        const cover = document.createElement('button');
        cover.type = 'button';
        cover.className = 'screenplay-title-page-cover';
        cover.setAttribute('aria-label', 'Add or change cover art');
        cover.title = 'Add or change cover art';
        const coverImage = document.createElement('img');
        coverImage.alt = '';
        const coverEmpty = document.createElement('span');
        coverEmpty.textContent = 'Add cover art';
        cover.append(coverImage, coverEmpty);
        cover.addEventListener('click', () => this.callbacks.onTitlePageCoverClick?.());
        this.titlePageFields.cover = cover;
        this.titlePageFields.coverImage = coverImage;
        optional.append(logline, cover);

        main.append(title, credit, author, optional);
        page.appendChild(main);
        this.setTitlePageMeta(this.titlePageMeta, { force: true });
        return page;
    }

    _createTitlePageField (name, placeholder, tagName = 'div') {
        const field = document.createElement(tagName);
        field.className = `screenplay-title-page-field screenplay-title-page-${name}`;
        field.contentEditable = 'plaintext-only';
        field.dataset.field = name;
        field.dataset.placeholder = placeholder;
        field.setAttribute('role', 'textbox');
        const labels = { title: 'Script title', author: 'Author name', logline: 'Logline' };
        field.setAttribute('aria-label', labels[name] || name);
        field.setAttribute('spellcheck', 'true');
        field.addEventListener('input', () => this._emitTitlePageChange(name, field.textContent || ''));
        if (name === 'title' || name === 'author') {
            field.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                field.blur();
            });
        }
        this.titlePageFields[name] = field;
        return field;
    }

    _emitTitlePageChange (field, value) {
        this.titlePageMeta[field] = value;
        this.callbacks.onTitlePageChange?.({ [field]: value });
    }

    _buildToolbarUI () {
        const chipsGroup = document.createElement('div');
        chipsGroup.className = 'screenplay-toolbar-chips';

        const lineTypeLabel = document.createElement('label');
        lineTypeLabel.className = 'screenplay-line-type-control';
        const lineTypeText = document.createElement('span');
        lineTypeText.textContent = 'Line Type:';
        this.lineTypeSelect = document.createElement('select');
        this.lineTypeSelect.className = 'screenplay-line-type-select';
        this.lineTypeSelect.setAttribute('aria-label', 'Line type');
        Object.keys(FORMAT_DISPLAY_NAMES).forEach(fmt => {
            const option = document.createElement('option');
            option.value = fmt;
            option.textContent = FORMAT_DISPLAY_NAMES[fmt];
            this.lineTypeSelect.appendChild(option);
        });
        this.lineTypeSelect.addEventListener('change', (event) => {
            this.setLineFormat(event.target.value);
        });
        lineTypeLabel.append(lineTypeText, this.lineTypeSelect);
        chipsGroup.appendChild(lineTypeLabel);

        if (this.toolbarHost) {
            this.toolbarHost.innerHTML = '';
            this.toolbarHost.classList.remove('is-inactive');
            this.toolbarHost.setAttribute('aria-hidden', 'false');
            this.toolbarHost.classList.add('screenplay-toolbar', 'is-hosted', `theme-${this.theme}`);
            this.toolbarHost.appendChild(chipsGroup);
            this.toolbar = this.toolbarHost;
            return;
        }

        this.toolbar = document.createElement('div');
        this.toolbar.className = 'screenplay-toolbar';
        this.toolbar.appendChild(chipsGroup);
        this.wrapper.appendChild(this.toolbar);
    }

    _initEngine () {
        this.pageManager = new PageManager({
            container: this.scriptPages,
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
            target: this.scaleTarget,
            onLayoutModeChange: () => this.pageManager?.schedulePagination()
        });
        this.viewportScaler.start();

        this.pageScrollIndicator = new PageScrollIndicator({
            wrapper: this.wrapper,
            workspace: this.workspace,
            pageManager: this.pageManager
        });
        this.pageScrollIndicator.start();

        this.workspace.addEventListener('input', () => this._notifyChange());
        this.workspace.addEventListener('keyup', () => this._updateSelectionState());
        this.workspace.addEventListener('click', (event) => {
            if (!event.target.closest?.('.screenplay-title-page')) {
                this.focusInitialSceneHeading({ preventScroll: true });
            }
            this._updateSelectionState();
        });

        if (document.fonts?.ready) {
            document.fonts.ready.then(() => {
                if (!this.wrapper?.isConnected) return;
                this.pageManager?.schedulePagination();
                this.viewportScaler?.scheduleUpdate();
            });
        }
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
        if (this.pageScrollIndicator) this.pageScrollIndicator.refresh(false);
    }

    getRawScript (format) {
        const currentDoc = this.getScriptDocument();
        return RawScriptAdapter.serialize(currentDoc, format || this.format);
    }

    setTitlePageMeta (meta = {}, { force = false } = {}) {
        this.titlePageMeta = { ...this.titlePageMeta, ...meta };
        for (const name of ['title', 'author', 'logline']) {
            const field = this.titlePageFields[name];
            if (!field || (!force && document.activeElement === field)) continue;
            const next = String(this.titlePageMeta[name] || '');
            if (field.textContent !== next) field.textContent = next;
        }
        const coverUrl = this.titlePageMeta.coverUrl || '';
        const cover = this.titlePageFields.cover;
        const image = this.titlePageFields.coverImage;
        if (cover && image) {
            cover.classList.toggle('has-cover', Boolean(coverUrl));
            if (coverUrl) image.src = coverUrl;
            else image.removeAttribute('src');
        }
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

    /**
     * Focus the first Scene Heading when the rendered screenplay contains no text.
     * This keeps an empty page immediately writable without changing non-empty scripts.
     */
    focusInitialSceneHeading ({ preventScroll = false } = {}) {
        if (!this.workspace) return false;
        const lines = Array.from(this.workspace.querySelectorAll('.script-line'));
        if (!lines.length || lines.some(line => (line.textContent || '').trim())) return false;

        const firstLine = lines[0];
        firstLine.setAttribute('data-format', VALID_FORMATS.HEADER);
        this.domHandler?.focusLine(firstLine, 0, { preventScroll });
        this._updateSelectionState();
        return true;
    }

    setTheme (theme) {
        this.theme = theme === 'light' ? 'light' : 'dark';
        if (this.wrapper) {
            this.wrapper.classList.remove('theme-dark', 'theme-light');
            this.wrapper.classList.add(`theme-${this.theme}`);
        }
        if (this.toolbarHost) {
            this.toolbarHost.classList.remove('theme-dark', 'theme-light');
            this.toolbarHost.classList.add(`theme-${this.theme}`);
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
            if (this.viewportScaler) this.viewportScaler.scheduleUpdate();
        }
    }

    _notifyChange () {
        this.isDirty = true;
        const currentDoc = this.getScriptDocument();
        const rawText = RawScriptAdapter.serialize(currentDoc, this.format);
        if (this.pageManager) this.pageManager.schedulePagination();
        if (this.viewportScaler) this.viewportScaler.scheduleUpdate();
        if (this.pageScrollIndicator) this.pageScrollIndicator.refresh(false);

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
            if (this.lineTypeSelect) this.lineTypeSelect.value = currentFormat;

            if (typeof this.callbacks.onSelectionChange === 'function') {
                this.callbacks.onSelectionChange({
                    format: currentFormat,
                    lineElement: activeLine
                });
            }
        }
    }

    _handleEngineEvent (event, data) {
        if (event === EDITOR_EVENTS.CONTENT_CHANGED) {
            this._notifyChange();
        }
    }

    destroy () {
        if (this.pageScrollIndicator) {
            this.pageScrollIndicator.destroy();
            this.pageScrollIndicator = null;
        }
        if (this.viewportScaler) {
            this.viewportScaler.destroy();
            this.viewportScaler = null;
        }
        if (this.keyboardManager) {
            this.keyboardManager.destroy();
        }
        if (this.pageManager) {
            this.pageManager.destroy();
        }
        if (this.helpModal) {
            this.helpModal.destroy();
        }
        if (this.toolbarHost) {
            this.toolbarHost.innerHTML = '';
            this.toolbarHost.classList.add('is-inactive');
            this.toolbarHost.setAttribute('aria-hidden', 'true');
        }
        this.container.innerHTML = '';
    }
}
